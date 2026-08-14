/**
 * LINE Pay v4 response fixtures.
 *
 * Fixtures carrying a transactionId are RAW JSON STRINGS, not objects: the
 * ids are int64 JSON numbers past Number.MAX_SAFE_INTEGER, and the whole
 * point of the precision tests is that the adapter must survive parsing the
 * exact bytes the gateway sends. `HttpResponse.json()` would round them at
 * fixture-definition time.
 */

/** The canonical 19-digit id used across fixtures — one digit past 2^53 precision. */
export const TX_ID = "2023042201206549310";
/** What JSON.parse would round TX_ID to — asserted against, must never appear. */
export const TX_ID_ROUNDED = "2023042201206549200";

/**
 * 付款請求 success. Synthesized from the request-payment doc example
 * (developers-pay.line.me/zh/online-api-v4/request-payment, fetched
 * 2026-08-13) — re-record with LINEPAY_LIVE=1 + PAID_DEBUG=1.
 */
export const REQUEST_SUCCESS_JSON = `{
  "returnCode": "0000",
  "returnMessage": "Success.",
  "info": {
    "paymentUrl": {
      "web": "https://sandbox-web-pay.line.me/web/payment/wait?transactionReserveId=REPLACEME",
      "app": "line://pay/payment/REPLACEME"
    },
    "transactionId": ${TX_ID},
    "paymentAccessToken": "056579816895"
  }
}`;

/**
 * 付款授權 (confirm) success — doc example shape (split card + points pay).
 * Synthesized; confirm cannot be recorded headlessly (needs a human to
 * approve in the sandbox wallet).
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

/** 退款 success — doc example shape; refundTransactionId is int64 too. */
export const REFUND_SUCCESS_JSON = `{
  "returnCode": "0000",
  "returnMessage": "success",
  "info": {
    "refundTransactionId": 2023042201206549311,
    "refundTransactionDate": "2026-08-13T09:15:01Z"
  }
}`;

export const REFUND_TX_ID = "2023042201206549311";

/**
 * 查詢付款明細 — a paid transaction, no refunds. Doc example shape
 * (retrieve-payment-details), amounts adjusted to be internally consistent.
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

/** Same transaction after a partial refund (refundAmount recorded negative). */
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

/** An empty details result — the gateway can answer 0000 with no entries. */
export const DETAILS_EMPTY_JSON = `{
  "returnCode": "0000",
  "returnMessage": "success",
  "info": []
}`;
