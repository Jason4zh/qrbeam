# 第三方组件

qrbeam 本体以 MIT 协议发布（见 `LICENSE`）。仓库里内联了两份第三方源码，
以便页面在完全离线的环境下也能打开，它们的许可证如下。

## qrcode-generator

- 文件：`app/lib/qrcode.js`
- 版本：2.0.4
- 作者：Kazuhiko Arase
- 许可证：MIT（全文见 `app/lib/qrcode-generator.LICENSE.txt`）
- 来源：<https://github.com/kazuhikoarase/qrcode-generator>
- 用途：发送端把每一帧的文本编码成二维码。
- 说明：文件原样内联，未做任何修改。

## jsQR

- 文件：`app/lib/jsQR.js`
- 版本：1.4.0
- 许可证：Apache-2.0（全文见 `app/lib/jsQR.LICENSE.txt`）
- 来源：<https://github.com/cozmo/jsQR>
- 用途：接收端从摄像头画面里定位并解码二维码。
- 说明：文件原样内联，未做任何修改。

## 其它

- Base45 编解码（`app/lib/base45.js`）按 RFC 9285 自行实现。
- LT 喷泉码、线格式、网格扫描与自动对齐均为本项目自行实现。

QR Code 是 DENSO WAVE INCORPORATED 的注册商标。
