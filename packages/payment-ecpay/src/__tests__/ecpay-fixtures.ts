/**
 * Real ECPay QueryTradeInfo/V5 responses, recorded live from the public stage
 * merchant {@link import("../config.js").ECPAY_SANDBOX} (MerchantID 3002607).
 * The same HashKey/HashIV sign offline MSW fixtures and live requests.
 *
 * Findings that constructed fixtures would have missed:
 *   - QueryTradeInfo answers HTTP 200 with a *full field set* (never a
 *     `code|message` string) even for a missing order.
 *   - A non-existent order returns TradeStatus=10200047 (not the 10200095 the
 *     doc summary implies); an empty MerchantTradeNo returns 10200052.
 *   - The payload carries PaymentTypeChargeFee + StoreID + CustomField1-4 and is
 *     ordered A→Z; PaymentDate/TradeDate use a literal space (`yyyy/MM/dd HH:mm:ss`).
 *
 * QUERY_PAID was captured by driving a real card payment on stage (test card
 * 4311-9522-2222-2222, 3D OTP 1234) then querying the settled order.
 *
 * Re-record:
 *   ECPAY_LIVE=1 PAID_DEBUG=1 pnpm test -- ecpay-live
 */

/** Known paid order id from the recorded QUERY_PAID fixture. */
export const STAGE_PAID_MER_TRADE_NO = "paidcli1782998612529";

/** Known probe id used when recording QUERY_NOT_FOUND. */
export const STAGE_PROBE_MER_TRADE_NO = "paidcli-probe-001";

/** A settled credit-card order → TradeStatus 1 (paid). Recorded post-payment. */
export const QUERY_PAID =
  "CustomField1=&CustomField2=&CustomField3=&CustomField4=&HandlingCharge=30" +
  "&ItemName=paidcli test&MerchantID=3002607&MerchantTradeNo=paidcli1782998612529" +
  "&PaymentDate=2026/07/02 21:27:45&PaymentType=Credit_CreditCard&PaymentTypeChargeFee=31" +
  "&StoreID=&TradeAmt=1234&TradeDate=2026/07/02 21:24:11&TradeNo=2607022124117236" +
  "&TradeStatus=1" +
  "&CheckMacValue=63850FCB511519F566886EB7D34B4DC449537F7549625DA5BF6FE0BA61F7ACE9";

/** Unknown (well-formed) MerchantTradeNo → TradeStatus 10200047 (查無交易資料). */
export const QUERY_NOT_FOUND =
  "HandlingCharge=0&ItemName=&MerchantID=3002607&MerchantTradeNo=paidcli-probe-001" +
  "&PaymentDate=&PaymentType=&PaymentTypeChargeFee=0&TradeAmt=0&TradeDate=&TradeNo=" +
  "&TradeStatus=10200047" +
  "&CheckMacValue=F874E8D5FE8B1306F6CE10A4C5E30D3E20C3F22B51DEB641440B9F7A8B7FB865";

/** Empty MerchantTradeNo → TradeStatus 10200052 (MerchantTradeNo 錯誤). */
export const QUERY_BAD_MERTRADENO =
  "HandlingCharge=0&ItemName=&MerchantID=3002607&MerchantTradeNo=" +
  "&PaymentDate=&PaymentType=&PaymentTypeChargeFee=0&TradeAmt=0&TradeDate=&TradeNo=" +
  "&TradeStatus=10200052" +
  "&CheckMacValue=C3A9CB1F080B964C4D8DEA258B19E402B5846916BCB103F944E03B6868380039";
