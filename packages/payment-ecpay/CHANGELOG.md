# @paid-tw/payment-ecpay

## 0.1.0

### Minor Changes

- **AIO（`createEcpayProvider`，name `ecpay`）**  
  - create → AioCheckOut V5，`mode: "redirect"`  
  - get → QueryTradeInfo/V5  
  - refund / capture / cancelClose / abandon → DoAction R/C/E/N  
  - `queryCreditTrade`（CreditDetail/QueryTrade/V2）  
  - `verifyPaymentNotify` + `ECPAY_NOTIFY_ACK`（ReturnURL form CheckMacValue）  
  - 公開 stage 常數 `ECPAY_SANDBOX` / `ECPAY_SANDBOX_PORTAL`  
  - create 固定 `NeedExtraPaidInfo=Y`
- **站內付 2.0（`createEcpayEcpgProvider`，name `ecpay-ecpg`）**  
  - create → GetTokenbyTrade，`mode: "token"`  
  - `createPaymentWithPayToken`  
  - AES-JSON client  
  - `verifyEcpgPaymentNotify` + `ECPG_NOTIFY_ACK`  
- MSW + live（`ECPAY_LIVE=1`）測試與覆蓋文件。
