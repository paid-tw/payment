/**
 * LINE Pay v4 response fixtures.
 *
 * Fixtures carrying a transactionId are RAW JSON STRINGS, not objects: the
 * ids are int64 JSON numbers past Number.MAX_SAFE_INTEGER, and the whole
 * point of the precision tests is that the adapter must survive parsing the
 * exact bytes the gateway sends. `HttpResponse.json()` would round them at
 * fixture-definition time.
 *
 * Provenance: `request`/`check`/1150/2101 recorded live against the sandbox
 * 2026-08-13 (LINEPAY_LIVE=1 + PAID_DEBUG=1). `confirm`/`refund`/`details`
 * successes are synthesized from the v4 doc examples — recording them needs
 * a human approving the payment in the sandbox wallet.
 */

/**
 * A live sandbox transactionId (recorded 2026-08-13). One digit past float64
 * precision: JSON.parse rounds it to {@link TX_ID_ROUNDED}.
 */
export const TX_ID = "2026081402375151710";
/** What JSON.parse would round TX_ID to — asserted against, must never appear. */
export const TX_ID_ROUNDED = "2026081402375151600";

/** 付款請求 success — recorded live 2026-08-13, transactionId → {@link TX_ID}. */
export const REQUEST_SUCCESS_JSON = `{"returnCode":"0000","returnMessage":"Success.","info":{"paymentUrl":{"web":"https://sandbox-web-pay.line.me/web/payment/wait?transactionReserveId=YTVUcm0xaWpYTjhva20wV2NJOXE3UU8vUzVFQ2s3OC9mamY3V3pTNEF5R00zWGJ1RUJGbHpaT0RCTzF4YkgyRA","app":"line://pay/payment/YTVUcm0xaWpYTjhva20wV2NJOXE3UU8vUzVFQ2s3OC9mamY3V3pTNEF5R00zWGJ1RUJGbHpaT0RCTzF4YkgyRA"},"transactionId":${TX_ID},"paymentAccessToken":"179097132890"}}`;

/**
 * 查詢付款請求狀態 while the buyer hasn't authenticated — recorded live
 * 2026-08-13. No `info` field; the returnCode IS the status.
 */
export const CHECK_PENDING_JSON = `{"returnCode":"0000","returnMessage":"reserved transaction."}`;

/**
 * 查無交易 — recorded live 2026-08-13. Unknown ids AND not-yet-confirmed
 * transactions both answer this coded error (not an empty list).
 */
export const DETAILS_NOT_FOUND_JSON = `{"returnCode":"1150","returnMessage":"Transaction record not found."}`;

/**
 * 付款授權 (confirm) success — doc example shape (split card + points pay).
 * Synthesized; confirm cannot be recorded headlessly.
 */
export const CONFIRM_SUCCESS_JSON = `{
  "returnCode": "0000",
  "returnMessage": "OK",
  "info": {
    "orderId": "ORDER_20260813_1000001",
    "transactionId": ${TX_ID},
    "payInfo": [
      { "method": "CREDIT_CARD", "amount": 90 },
      { "method": "POINT", "amount": 10 }
    ],
    "paymentProvider": "TSP"
  }
}`;

/** 退款 success — doc example shape; refundTransactionId is int64 too. Synthesized. */
export const REFUND_SUCCESS_JSON = `{
  "returnCode": "0000",
  "returnMessage": "success",
  "info": {
    "refundTransactionId": 2026081402375151711,
    "refundTransactionDate": "2026-08-13T09:15:01Z"
  }
}`;

export const REFUND_TX_ID = "2026081402375151711";

/**
 * 查詢付款明細 — a paid transaction, no refunds. Doc example shape
 * (retrieve-payment-details), amounts adjusted to be internally consistent.
 * Synthesized.
 */
export const DETAILS_PAID_JSON = `{
  "returnCode": "0000",
  "returnMessage": "success",
  "info": [
    {
      "transactionId": ${TX_ID},
      "transactionDate": "2026-08-13T09:00:00Z",
      "transactionType": "PAYMENT",
      "payInfo": [
        { "method": "CREDIT_CARD", "amount": 90 },
        { "method": "POINT", "amount": 10 }
      ],
      "productName": "paid-tw test product",
      "currency": "TWD",
      "orderId": "ORDER_20260813_1000001",
      "packages": [ { "id": "1", "amount": 100 } ],
      "refundList": []
    }
  ]
}`;

/** Same transaction after a partial refund (refundAmount recorded negative). Synthesized. */
export const DETAILS_PARTIAL_REFUND_JSON = `{
  "returnCode": "0000",
  "returnMessage": "success",
  "info": [
    {
      "transactionId": ${TX_ID},
      "transactionDate": "2026-08-13T09:00:00Z",
      "transactionType": "PAYMENT",
      "payInfo": [
        { "method": "CREDIT_CARD", "amount": 90 },
        { "method": "POINT", "amount": 10 }
      ],
      "currency": "TWD",
      "orderId": "ORDER_20260813_1000001",
      "refundList": [
        {
          "refundTransactionId": ${REFUND_TX_ID},
          "transactionType": "PARTIAL_REFUND",
          "refundAmount": -40,
          "refundTransactionDate": "2026-08-13T10:00:00Z"
        }
      ]
    }
  ]
}`;

/**
 * An empty details result. NOT observed live (unknown ids answer 1150, see
 * {@link DETAILS_NOT_FOUND_JSON}) — kept because the adapter defends against
 * a 0000-with-no-entries answer anyway.
 */
export const DETAILS_EMPTY_JSON = `{
  "returnCode": "0000",
  "returnMessage": "success",
  "info": []
}`;

/**
 * Path-variable overflow — recorded live 2026-08-13 by refunding
 * transactionId "9"×19: the gateway parses path ids as SIGNED INT64, and
 * anything past 2^63-1 fails parameter validation before lookup, with the
 * detail in `errorDetailMap` (a field the result-code table never mentions).
 */
export const REFUND_OVERFLOW_2101_JSON = `{"returnCode":"2101","returnMessage":"Parameter error.","errorDetailMap":{"unrecognizedPathVariable":"transactionId","requiredType":"Number","cause":"For input string: \\"9999999999999999999\\""}}`;
