/**
 * PAYUNi trade-query payloads, in the three decrypted shapes the adapter's
 * parser handles. Field names/values mirror PAYUNi's documented `trade/query`
 * response; the surrounding envelope is AES-encrypted locally with the test key
 * (see server.ts) so the full decrypt -> parse -> normalize path runs offline
 * and deterministically. Re-capture field-exact payloads from the sandbox with
 * PAYUNI_LIVE=1 (see live.test.ts).
 */

/** Shape 1 — decrypted body is a JSON object with a `Result` array. */
export const QUERY_JSON_PAID = JSON.stringify({
  Status: "SUCCESS",
  Message: "Success",
  MerID: "TESTMER01",
  Result: [
    {
      TradeNo: "UNI20260630000001",
      MerTradeNo: "ORDER-123",
      TradeStatus: "1",
      TradeAmt: "100",
      PaymentType: "1",
      PaymentDay: "2026-06-30 12:00:00",
      Card6No: "400022",
      Card4No: "1234",
      CardBank: "807",
      AuthCode: "123456",
      TradeFee: "3",
    },
  ],
});

/** Shape 2 — decrypted body is a querystring with flattened Result[0][Field] keys. */
export const QUERY_FLAT_LINEPAY = [
  "Status=SUCCESS",
  "Message=Success",
  "MerID=TESTMER01",
  "Result[0][TradeNo]=UNI20260630000002",
  "Result[0][MerTradeNo]=ORDER-456",
  "Result[0][TradeStatus]=1",
  "Result[0][TradeAmt]=250",
  "Result[0][PaymentType]=9",
  "Result[0][PaymentDay]=2026-06-30 13:30:00",
].join("&");

/** Shape 3 — decrypted body is a querystring whose `Result` is a JSON string. */
export const QUERY_QS_JSON_RESULT = [
  "Status=SUCCESS",
  "MerID=TESTMER01",
  `Result=${encodeURIComponent(
    JSON.stringify([
      {
        TradeNo: "UNI20260630000003",
        MerTradeNo: "ORDER-789",
        TradeStatus: "8",
        TradeAmt: "80",
        PaymentType: "2",
      },
    ]),
  )}`,
].join("&");
