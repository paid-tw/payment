---
"@paid-tw/payment-ecpay": minor
"@paid-tw/payment": minor
---

Add ECPay 非信用卡幕後取號 (background 取號) support: `createEcpayPayCodeProvider`
(`name: "ecpay-paycode"`) obtains an ATM 虛擬帳號, 超商代碼 or 超商條碼 server-side on
`ecpayment(-stage).ecpay.com.tw`, with no consumer redirect — the create response
carries the payment code itself.

- `createPayment` → `GenPaymentCode` for `method: "atm" | "cvs" | "barcode"`
- `getPayment` → `QueryTrade`; `getPaymentCode` → `QueryPaymentInfo` (the only way
  to re-read a code, since `QueryTrade`'s `ATMInfo` describes the payer)
- `verifyPaymentNotify` + `ECPAY_PAYCODE_NOTIFY_ACK` for the AES-JSON ReturnURL
- `refundPayment` throws `UNSUPPORTED`: ECPay ships no refund API for these methods
- `expireDate` is validated per method, because the unit differs (ATM/BARCODE count
  days, CVS counts minutes)

`PaymentMethod` gains `"barcode"`, and the AIO adapter maps it to
`ChoosePayment=BARCODE` instead of falling through to `ALL`.
