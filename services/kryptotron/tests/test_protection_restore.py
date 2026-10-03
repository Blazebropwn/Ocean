import copy
from datetime import datetime, timezone
from unittest.mock import Mock, patch
from test_bot_reconcile import BotStateTestCase
import bot
from protection_restore import process_restore

NOW = datetime(2026, 10, 3, 13, 0, tzinfo=timezone.utc)
FILTERS = {'BTCUSDC': (.00001, .01, 5), 'ETHUSDC': (.0001, .01, 5)}


class RestoreTests(BotStateTestCase):
    def fixture(self):
        state = self.state()
        state.update(entries_paused=True, safe_mode=True, api_permissions_safe=True)
        ps = {'in_position': True, 'entry_order_client_id': 'entry', 'position_qty': .00024, 'entry_price': 84000,
              'protection_client_id': 'ocean-protect-old', 'protection_order_list_id': 1, 'protection_status': 'CANCELLED',
              'protection_stop_price': 75600, 'protection_activation_price': 86520, 'protection_trailing_bips': 150}
        state['positions']['BTCUSDC'] = ps
        state['protection_restore'] = {'id': 'request', 'symbol': 'BTCUSDC', 'position_id': 'entry', 'protection_id': 'ocean-protect-old',
             'status': 'queued', 'quantity': .00024, 'stop_price': 75600, 'activation_price': 86520, 'trailing_bips': 150, 'requested_at': NOW.isoformat()}
        client = Mock()
        client.get_account.return_value = {'canTrade': True, 'balances': [{'asset': 'BTC', 'free': '.00024', 'locked': '0'}, {'asset': 'USDC', 'free': '60', 'locked': '0'}]}
        client.get_open_orders.return_value = []
        client.get_asset_balance.return_value = {'free': '.00024'}
        client.get_symbol_ticker.return_value = {'price': '84000'}
        client.get_symbol_info.return_value = {'filters': [{'filterType': 'TRAILING_DELTA', 'minTrailingBelowDelta': 10, 'maxTrailingBelowDelta': 2000}]}
        client.create_oco_order.return_value = {'orderListId': 2}
        sync = Mock(side_effect=lambda c,s,symbol: {'status': 'cancelled' if s['positions'][symbol]['protection_client_id']=='ocean-protect-old' else 'active'})
        return state, client, sync

    def run_restore(self, state, client, sync):
        return process_restore(client, state, FILTERS, save=bot.save_state, sync=sync, place=bot.place_protection, now=NOW)

    def test_explicit_request_restores_exact_terms_only_once_and_keeps_pause(self):
        state, client, sync = self.fixture()
        self.run_restore(state, client, sync)
        self.assertEqual(state['protection_restore']['status'], 'completed')
        self.assertTrue(state['entries_paused'])
        self.assertTrue(state['safe_mode'])  # normal reconciliation clears it later
        kwargs = client.create_oco_order.call_args.kwargs
        self.assertEqual(kwargs['quantity'], '0.00024')
        self.assertEqual(kwargs['belowStopPrice'], '75600')
        self.assertEqual(kwargs['aboveStopPrice'], '86520')
        self.assertEqual(kwargs['aboveTrailingDelta'], 150)
        self.run_restore(state, client, sync)
        client.create_oco_order.assert_called_once()
        client.order_market_buy.assert_not_called()
        client.order_market_sell.assert_not_called()

    def test_no_request_never_creates_protection(self):
        state, client, sync = self.fixture(); state.pop('protection_restore')
        self.run_restore(state, client, sync)
        client.create_oco_order.assert_not_called()

    def test_inventory_mismatch_or_other_unknown_order_blocks_restoration(self):
        for change in ('inventory', 'order', 'permissions', 'unpaused', 'pending', 'terms', 'price', 'free', 'stale', 'active'):
            with self.subTest(change=change):
                state, client, sync = self.fixture()
                if change=='inventory': client.get_account.return_value['balances'][0]['free']='.01'
                if change=='order': client.get_open_orders.return_value=[{'symbol':'BTCUSDC','orderListId':99,'clientOrderId':'other'}]
                if change=='permissions': state['api_permissions_safe']=False
                if change=='unpaused': state['entries_paused']=False
                if change=='pending': state['pending_order']={'side':'BUY'}
                if change=='terms': state['positions']['BTCUSDC']['position_qty']=.001
                if change=='price': client.get_symbol_ticker.return_value={'price':'74000'}
                if change=='free': client.get_asset_balance.return_value={'free':'0'}
                if change=='stale': state['protection_restore']['requested_at']='2020-01-01T00:00:00+00:00'
                if change=='active': sync.side_effect=None;sync.return_value={'status':'active'}
                self.run_restore(state,client,sync)
                self.assertEqual(state['protection_restore']['status'],'rejected')
                client.create_oco_order.assert_not_called()

    def test_changed_position_is_superseded_without_order(self):
        state, client, sync = self.fixture();state['positions']['BTCUSDC']['entry_order_client_id']='new-entry'
        self.run_restore(state,client,sync)
        self.assertEqual(state['protection_restore']['status'],'superseded')
        client.create_oco_order.assert_not_called()

    def test_other_missing_protection_does_not_prevent_restoring_one_at_a_time(self):
        state,client,sync=self.fixture()
        state['positions']['ETHUSDC']={'in_position':True,'position_qty':.0071,'protection_order_list_id':3}
        client.get_account.return_value['balances'].append({'asset':'ETH','free':'.0071','locked':'0'})
        self.run_restore(state,client,sync)
        self.assertEqual(state['protection_restore']['status'],'completed')
        client.create_oco_order.assert_called_once()

    def test_lost_exchange_reply_recovers_by_same_id_without_second_order(self):
        state,client,sync=self.fixture()
        client.create_oco_order.side_effect=TimeoutError('lost reply')
        with self.assertRaises(TimeoutError):self.run_restore(state,client,sync)
        restored=copy.deepcopy(state)
        self.assertEqual(restored['protection_restore']['status'],'submitting')
        pending_id=restored['pending_protection']['listClientOrderId']
        with self.assertRaisesRegex(RuntimeError,'další se neodesílá'):self.run_restore(restored,client,sync)
        client.v3_get_order_list.return_value={'orderListId':2}
        bot.reconcile_pending_protection(client,restored)
        self.run_restore(restored,client,sync)
        self.assertEqual(restored['positions']['BTCUSDC']['protection_client_id'],pending_id)
        self.assertEqual(restored['protection_restore']['status'],'completed')
        client.create_oco_order.assert_called_once()

    def test_failed_intent_save_does_not_submit_and_does_not_retry_automatically(self):
        state,client,sync=self.fixture()
        with patch.object(bot.db,'save_state',return_value=False):
            with self.assertRaises(RuntimeError):self.run_restore(state,client,sync)
        with self.assertRaises(RuntimeError):self.run_restore(state,client,sync)
        client.create_oco_order.assert_not_called()

    def test_cancelled_protection_cannot_be_automatically_rearmed(self):
        state,client,sync=self.fixture()
        ps=state['positions']['BTCUSDC']
        state['reconciliation']={'status':'UNRESOLVED','issues':[{'code':'PROTECTION_ERROR','symbol':'BTCUSDC'}]}
        with self.assertRaisesRegex(RuntimeError,'výslovné potvrzení'):
            bot.secure_protection_or_exit(client,state,'BTCUSDC',ps,'BTC',.00001,.01,(10,2000))
        client.create_oco_order.assert_not_called()
