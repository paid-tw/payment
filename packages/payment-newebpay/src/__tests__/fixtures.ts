/**
 * NewebPay payloads for the offline MSW suite.
 *
 * `QUERY_CREDIT_PAID_RESULT` and the `MANUAL_NOTIFY_*` constants are copied
 * character-for-character from the NDNF-1.2.3 manual's worked examples (the
 * notify ciphertext was produced by the real gateway, so it exercises the full
 * TradeSha → decrypt → parse path against genuine gateway output). The other
 * payloads are synthesized field-by-field from the manual's field tables —
 * re-record them from the sandbox with NEWEBPAY_LIVE=1 + PAID_DEBUG=1 (see
 * live.test.ts) whenever the gateway shape drifts.
 */

/** Manual p.61 — QueryTradeInfo Result for a paid credit-card order (verbatim,
 * minus CheckCode which server.ts recomputes — the manual's own value matches). */
export const QUERY_CREDIT_PAID_RESULT = {
  MerchantID: "MS127874575",
  Amt: 30,
  TradeNo: "23092714215835071",
  MerchantOrderNo: "Vanespl_ec_1695795668",
  TradeStatus: "1",
  PaymentType: "CREDIT",
  CreateTime: "2023-09-27 14:21:59",
  PayTime: "2023-09-27 14:21:59",
  FundTime: "0000-00-00",
  RespondCode: "00",
  Auth: "115468",
  ECI: null,
  CloseAmt: null,
  CloseStatus: "0",
  BackBalance: "30",
  BackStatus: "0",
  RespondMsg: "授權成功",
  Inst: "0",
  InstFirst: "0",
  InstEach: "0",
  PaymentMethod: "CREDIT",
  Card6No: "400022",
  Card4No: "1111",
  AuthBank: "KGI",
};

/**
 * Synthesized money-state variants of the paid fixture, per the credit-card
 * state machine (§3/圖5): declined, voided (取消授權), and fully refunded.
 */
export const QUERY_CREDIT_FAILED_RESULT = {
  ...QUERY_CREDIT_PAID_RESULT,
  MerchantOrderNo: "order_declined_001",
  TradeNo: "23092714215835072",
  TradeStatus: "2",
  PayTime: "",
  RespondCode: "05",
  Auth: "",
  RespondMsg: "授權失敗",
  BackBalance: "0",
};

export const QUERY_CREDIT_CANCELED_RESULT = {
  ...QUERY_CREDIT_PAID_RESULT,
  MerchantOrderNo: "order_voided_001",
  TradeNo: "23092714215835073",
  TradeStatus: "3",
  BackBalance: "0",
};

export const QUERY_CREDIT_REFUNDED_RESULT = {
  ...QUERY_CREDIT_PAID_RESULT,
  MerchantOrderNo: "order_refunded_001",
  TradeNo: "23092714215835074",
  TradeStatus: "6",
  CloseStatus: "3",
  CloseAmt: "30",
  BackStatus: "3",
  BackBalance: "0",
};

/**
 * Recorded live 2026-08-08 (ccore, real 取號 order created through the MPG
 * page; merchant id swapped for the doc sandbox one). Note the gateway sends
 * PayTime as a ZERO-DATE ("0000-00-00 00:00:00"), not an empty string.
 */
export const QUERY_VACC_UNPAID_RESULT = {
  MerchantID: "MS127874575",
  Amt: 30,
  TradeNo: "26080804351759265",
  MerchantOrderNo: "paidlive1786134867",
  TradeStatus: "0",
  PaymentType: "VACC",
  CreateTime: "2026-08-08 04:35:17",
  PayTime: "0000-00-00 00:00:00",
  FundTime: "0000-00-00",
  PayInfo: "(004)TestAccount12345",
  ExpireDate: "2026-08-15 23:59:59",
  OrderStatus: 0,
};

/** Synthesized: TWQR order awaiting bank confirmation (OrderStatus 9 = 付款中). */
export const QUERY_PENDING_RESULT = {
  MerchantID: "MS127874575",
  Amt: 500,
  TradeNo: "26080198765432109",
  MerchantOrderNo: "order_twqr_001",
  TradeStatus: "0",
  OrderStatus: 9,
  PaymentType: "TWQR",
  CreateTime: "2026-08-01 11:00:00",
  PayTime: "",
};

/**
 * Manual pp.23/25 — a REAL gateway-produced notify: envelope TradeInfo hex +
 * TradeSha verbatim, decrypting (RespondType=String) to a paid credit card.
 */
export const MANUAL_NOTIFY_TRADEINFO =
  "ee11d1501e6dc8433c75988258f2343d11f4d0a423be672e8e02aaf373c53c2363aeffdb4992579693277359b3e449ebe644d2075fdfbc10150b1c40e7d24cb215febefdb85b16a5cde449f6b06c58a5510d31e8d34c95284d459ae4b52afc1509c2800976a5c0b99ef24cfd28a2dfc8004215a0c98a1d3c77707773c2f2132f9a9a4ce3475cb888c2ad372485971876f8e2fec0589927544c3463d30c785c2d3bd947c06c8c33cf43e131f57939e1f7e3b3d8c3f08a84f34ef1a67a08efe177f1e663ecc6bedc7f82640a1ced807b548633cfa72d060864271ec79854ee2f5a170aa902000e7c61d1269165de330fce7d10663d1668c711571776365bfdcd7ddc915dcb90d31a9f27af9b79a443ca8302e508b0dbaac817d44cfc44247ae613075dde4ac960f1bdff4173b915e4344bc4567bd32e86be7d796e6d9b9cf20476e4996e98ccc315f1ed03a34139f936797d971f2a3f90bc18f8a155a290bcbcf04f4277171c305bf554f5cba243154b30082748a81f2e5aa432ef9950cc9668cd4330ef7c37537a6dcb5e6ef01b4eca9705e4b097cf6913ee96e81d0389e5f775";

export const MANUAL_NOTIFY_TRADESHA =
  "C80876AEBAC0036268C0E240E5BFF69C0470DE9606EEE083C5C8DD64FDB3347A";

/** Synthesized JSON-RespondType paid credit-card notify payload. */
export const NOTIFY_CREDIT_PAID_JSON = JSON.stringify({
  Status: "SUCCESS",
  Message: "授權成功",
  Result: {
    MerchantID: "MS127874575",
    Amt: 30,
    TradeNo: "23092714215835071",
    MerchantOrderNo: "Vanespl_ec_1695795668",
    PaymentType: "CREDIT",
    RespondType: "JSON",
    PayTime: "2023-09-27 14:21:59",
    IP: "123.51.237.115",
    EscrowBank: "HNCB",
    AuthBank: "KGI",
    RespondCode: "00",
    Auth: "115468",
    Card6No: "400022",
    Card4No: "1111",
    Inst: 0,
    InstFirst: 0,
    InstEach: 0,
    ECI: "",
    TokenUseStatus: 0,
    PaymentMethod: "CREDIT",
  },
});

/** Synthesized declined-card notify (Status carries the MPG error code). */
export const NOTIFY_CREDIT_DECLINED_JSON = JSON.stringify({
  Status: "MPG03009",
  Message: "交易失敗",
  Result: {
    MerchantID: "MS127874575",
    Amt: 30,
    TradeNo: "23092714215835072",
    MerchantOrderNo: "order_declined_001",
    PaymentType: "CREDIT",
    PayTime: "",
  },
});

/**
 * 取號完成 (get-code) payload for an ATM virtual account — recorded live
 * 2026-08-08 from a real CustomerURL POST (merchant id swapped for the doc
 * sandbox one). Note ExpireTime arrives COLONED ("23:59:59"), not the `His`
 * format the manual documents for the request side.
 */
export const GETCODE_VACC_JSON = JSON.stringify({
  Status: "SUCCESS",
  Message: "取號成功",
  Result: {
    MerchantID: "MS127874575",
    Amt: 30,
    TradeNo: "26080804351759265",
    MerchantOrderNo: "paidlive1786134867",
    PaymentType: "VACC",
    RespondType: "JSON",
    ExpireDate: "2026-08-15",
    ExpireTime: "23:59:59",
    BankCode: "004",
    CodeNo: "TestAccount12345",
    CardBank: null,
  },
});

/** Synthesized paid-VACC notify — the completion event of the ATM flow. */
export const NOTIFY_VACC_PAID_JSON = JSON.stringify({
  Status: "SUCCESS",
  Message: "付款成功",
  Result: {
    MerchantID: "MS127874575",
    Amt: 1200,
    TradeNo: "26080112345678901",
    MerchantOrderNo: "order_atm_001",
    PaymentType: "VACC",
    PayTime: "2026-08-02 10:15:00",
    PayBankCode: "012",
    PayerAccount5Code: "12345",
  },
});

/** Synthesized paid-barcode notify (three Code39 segments + paying chain). */
export const NOTIFY_BARCODE_PAID_JSON = JSON.stringify({
  Status: "SUCCESS",
  Message: "付款成功",
  Result: {
    MerchantID: "MS127874575",
    Amt: 700,
    TradeNo: "26080134567890123",
    MerchantOrderNo: "order_barcode_001",
    PaymentType: "BARCODE",
    PayTime: "2026-08-03 18:00:00",
    Barcode_1: "150808A3",
    Barcode_2: "3453011122223333",
    Barcode_3: "060517000000700",
    RepayTimes: 1,
    PayStore: "SEVEN",
  },
});

/** Synthesized paid-CVS notify (paid shape carries CodeNo + store fields). */
export const NOTIFY_CVS_PAID_JSON = JSON.stringify({
  Status: "SUCCESS",
  Message: "付款成功",
  Result: {
    MerchantID: "MS127874575",
    Amt: 700,
    TradeNo: "26080123456789012",
    MerchantOrderNo: "order_cvs_001",
    PaymentType: "CVS",
    PayTime: "2026-08-02 09:30:00",
    CodeNo: "GW26080100001234",
    StoreType: 1,
    StoreID: "990088",
  },
});

/** Synthesized Close (refund) SUCCESS Result. */
export const CLOSE_REFUND_RESULT = {
  MerchantID: "MS127874575",
  Amt: 30,
  TradeNo: "23092714215835071",
  MerchantOrderNo: "Vanespl_ec_1695795668",
};

/** Synthesized Cancel (取消授權) SUCCESS Result (CheckCode added by server.ts). */
export const CANCEL_AUTH_RESULT = {
  MerchantID: "MS127874575",
  Amt: 30,
  TradeNo: "23092714215835071",
  MerchantOrderNo: "Vanespl_ec_1695795668",
};
