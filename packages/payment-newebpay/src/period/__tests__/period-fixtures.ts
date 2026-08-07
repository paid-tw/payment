/**
 * 定期定額 payloads. The three `MANUAL_*_HEX` blobs are copied
 * character-for-character from the NDNP-1.0.7 manual's worked examples and
 * decrypt under the manual's sandbox credentials (period-server.ts) — they are
 * genuine gateway envelope output. The JSON payloads are synthesized from the
 * manual's field tables; re-record with NEWEBPAY_LIVE=1 + PAID_DEBUG=1 when
 * the gateway shape drifts.
 */

/**
 * NDNP §4.2/§4.3.2 — the create-result `Period` blob delivered to NotifyURL.
 * Decrypts to: mandate created + first auth OK (PeriodStartType=2),
 * PeriodNo P231115153213aMDNWZ, 12 scheduled dates, CardNo 400022******1111.
 */
export const MANUAL_CREATE_RESULT_HEX =
  "e88f62186b6d5dd96a9f6dbc57a84547957e8cb8534d81cbed42dcffa93783a30fad037c450ed467d60f44e51b3525829e204ae0d3792a9f2c7e8af7df196ddc678579b76f76f64f0322f7e41587076372b69023b1681d022d219f78deced25f941e5902905f4f5009d84aa35f1c4dc0cee9bbd4ba9a67228775927a14ff86f46259388845ba59a1c59c3007bf5534bae63616e1e705a63dc9615d3be00d4bf04f04af1ebc229f34e34c80b31d14d39f519099650bfaa7f9228ad15c7f79797d3ada0ba648bb33a8fd82937061e83b2916b92510617d52cff39adb1b0d1204d9e07b3f79d709344852579671c68d8844348b80f4a35450d860b232f3aeb7728c24135e438f0893089e445bdc62429126a5b37c7e09b1226e05d53127498fbcf407f241c8d752298a29642df3671f8277b9849370d2234a69fbfd415ab3449953233a4eaa2e1aa5827f30c482cf8efcdecff5587f75045f60336eb2133b658834736642f99305f0d245c0714696a238b1d9364659f7240c25a1e66d04af35f7f077498dad65b82256342549ba34e2ff75880ef9fb1e025999ee619eef10388642a09eacebe3c19be1d8077ee1a73d53a7168e835a13361248a54d83d944b33ace6f8159aa38b9ab0b408bbab3bedb9affcf43a3ae4415c5a657a66ab026f7c53ada3b2920e741fa19c62bf19d21932239a3116ae3ccf0aabf06bb99ddcefb3976dbb75c45599a17f24fdedbb30e232c969fa2a1d5d1e21258ed21705ae969d97c756e742be64c7f4c6ed520b35fa5fa1689c40b3f8929f7ee082076cbcf585536e1f2e2ff1042934eaf57577efd7c403c562b1ea106aaea3e36f69e3eeba8e0ea";

/** NDNP §6 — AlterStatus (suspend) response `period` blob. */
export const MANUAL_ALTER_STATUS_RESP_HEX =
  "e88f62186b6d5dd96a9f6dbc57a84547957e8cb8534d81cbed42dcffa93783a32940ba6716e1ebb85f3d92fbcf0497897d312c0181e878b2d1be5cafe7d7c2f81ab3327ed1b4529ced6c5c4c6d07c52e9943e9ec8f0735e8c9329c23789e3927e540f8f2a56517ddf37d6ee7196d41e0139d173616ccf964b40764109f8647851cf17a5eb3d75eb0fe017d45790e528528c59adfe84cf2518dbf7cf71776bed9768ca6a74103332dbfb7d0356fbeb230d9bcda35763ca6eaaad51033ab6f35195780ea6ac3f584adc78940e9a053858b657461a94a20942fd559f54f9843433a";

/** NDNP §7 — AlterAmt response `Period` blob (AlterAmt=15, ExtDay 2908, NotifyURL "-"). */
export const MANUAL_ALTER_AMT_RESP_HEX =
  "e88f62186b6d5dd96a9f6dbc57a84547957e8cb8534d81cbed42dcffa93783a37f1430903fe81f68c67648f607b43a420e9bc9306a6f2c71bff6a0ce5094beda2c8665044429b98bbd1a81ccb5c88f77c08bfbc31ebb7994bf9f541c8893b566c1642eb0d8b78a200a11d58541081af1043595748de50098b70062a111a1e5d38f56b3cca7d74a6aaf21a304fbc5656c716c697add6633b9903491917a1148957386480db1268ae8814eae992c2d30d693ad4f9936f7199aa01ea151981e485f257077e7d461ff63a73749348c17a92b88d4895b4d1854ba2ce7eee340e20d00d3d7cc3ebbdcc60ea67dd154a424b4fc41fe7967a44bbefe33e4816a53087c5cf0e50e5acead8a65fb53ac38f9fdcafd876f7aabaf8049a60c5a5369d52f4e9cd19f07b1d93772bca07a51141f298708dc9fa72ec9f5cad686ce3c79bfca2efec08b7c01bf44c9e76723e491d3a08d15fc0f879343b406723d6e99a64072a83e";

/** Synthesized N050 each-period notify (fields from the manual's example). */
export const CYCLE_NOTIFY_JSON = JSON.stringify({
  Status: "SUCCESS",
  Message: "授權成功",
  Result: {
    RespondCode: "00",
    MerchantID: "TEK1682407426",
    MerchantOrderNo: "periodi1655708272",
    OrderNo: "periodi1655708272_2",
    TradeNo: "22062407181613548",
    AuthDate: "2022-06-24 07:18:17",
    TotalTimes: "12",
    AlreadyTimes: "2",
    AuthAmt: 20,
    NextAuthDate: "2022-06-26",
    AuthCode: "681234",
    EscrowBank: "HNCB",
    AuthBank: "KGI",
    PeriodNo: "P220620145859us4Rlj",
  },
});

/** Synthesized N050 failed-period notify (schedule keeps running regardless). */
export const CYCLE_NOTIFY_FAILED_JSON = JSON.stringify({
  Status: "TRA10035",
  Message: "授權失敗",
  Result: {
    RespondCode: "05",
    MerchantID: "TEK1682407426",
    MerchantOrderNo: "periodi1655708272",
    OrderNo: "periodi1655708272_3",
    TradeNo: "22072407181613549",
    AuthDate: "2022-07-24 07:18:17",
    TotalTimes: "12",
    AlreadyTimes: "3",
    AuthAmt: 20,
    NextAuthDate: "2022-08-26",
    PeriodNo: "P220620145859us4Rlj",
  },
});
