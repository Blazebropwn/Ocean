class UnsafeBinancePermissions(RuntimeError):
    pass


def require_safe_api_permissions(client, testnet):
    if testnet:
        return

    permissions = client.get_account_api_permissions()
    if permissions.get("enableWithdrawals") is not False:
        raise UnsafeBinancePermissions("Nelze potvrdit, že API klíč má zakázané výběry")
    if permissions.get("enableReading") is not True:
        raise UnsafeBinancePermissions("API klíč nemá povolené čtení")
    if permissions.get("enableSpotAndMarginTrading") is not True:
        raise UnsafeBinancePermissions("API klíč nemá povolené spotové obchodování")
