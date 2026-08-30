import unittest
from datetime import datetime, timezone

from events import add_event
from schedule import (
    daily_summary_due,
    mark_daily_summary_sent,
    mark_weekly_summary_sent,
    weekly_summary_due,
)


class ScheduleTests(unittest.TestCase):
    def test_summary_becomes_due_at_20_prague_summer_time(self):
        state = {}
        self.assertFalse(daily_summary_due(state, datetime(2026, 8, 23, 17, 59, tzinfo=timezone.utc)))
        self.assertTrue(daily_summary_due(state, datetime(2026, 8, 23, 18, 0, tzinfo=timezone.utc)))

    def test_summary_uses_prague_winter_time_and_only_runs_once(self):
        now = datetime(2026, 12, 1, 19, 0, tzinfo=timezone.utc)
        state = {}
        self.assertTrue(daily_summary_due(state, now))
        mark_daily_summary_sent(state, now)
        self.assertFalse(daily_summary_due(state, now))
        self.assertEqual(state["last_daily_summary_date"], "2026-12-01")

    def test_weekly_summary_becomes_due_sunday_at_08_prague_summer_time(self):
        state = {}
        self.assertFalse(weekly_summary_due(state, datetime(2026, 8, 30, 5, 59, tzinfo=timezone.utc)))
        self.assertTrue(weekly_summary_due(state, datetime(2026, 8, 30, 6, 0, tzinfo=timezone.utc)))

    def test_weekly_summary_uses_winter_time_and_only_runs_once(self):
        now = datetime(2026, 12, 6, 7, 0, tzinfo=timezone.utc)
        state = {}
        self.assertTrue(weekly_summary_due(state, now))
        mark_weekly_summary_sent(state, now)
        self.assertFalse(weekly_summary_due(state, now))
        self.assertEqual(state["last_heartbeat_week"], "2026-W48")

    def test_weekly_summary_does_not_run_after_08_on_another_day(self):
        self.assertFalse(weekly_summary_due({}, datetime(2026, 8, 31, 8, 0, tzinfo=timezone.utc)))


class EventTests(unittest.TestCase):
    def test_events_are_newest_first_and_limited(self):
        state = {}
        for index in range(25):
            add_event(state, "TEST", f"Událost {index}")
        self.assertEqual(len(state["events"]), 20)
        self.assertEqual(state["events"][0]["message"], "Událost 24")
        self.assertEqual(state["events"][-1]["message"], "Událost 5")


if __name__ == "__main__":
    unittest.main()
