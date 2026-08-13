import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "BPA Browser Bridge",
    description: "Local BPA browser execution bridge",
    version: "0.6.4",
    version_name: process.env.BPA_RELEASE_IDENTITY ?? "development",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsJ4F8IoG8Ow7EhbYFBwlwE51+P0oxTZJxDUuNH+CUER0wwJAcl28QVvpRgUupTu/uS4B8VSimtSsfLM7rP4114DRObC2ZzNL4hbSLMdJNTCu0fzD39LSy9vK+5roj69+bQKlgNyYtWMw5ayj20xiGIGdDeTzjvZI1VyG5TQW2bYrSJ3D359NtCNZCCewLNrPoVKoAZlL1VRAWgarPmP72MNURgYtFb95EFCr8cn6n/Yz+5m2S5iQKq4akTFG7XM8FG7BuQ/REDlSs/Dhb/CA8MTYwKJfr3Pt3S3/aRArwzo1RMvEPDlwVwi0RZetuFB/6SQf2crcCwregu0iMV6kLQIDAQAB",
    permissions: [
      "nativeMessaging",
      "scripting",
      "storage",
      "tabs",
      "webNavigation"
    ],
    host_permissions: [
      "https://www.binance.com/*",
      "https://fxg.jinritemai.com/*",
      "https://buyin.jinritemai.com/*",
      "https://www.chanmama.com/*",
      "https://www.douyin.com/*",
      "https://s.taobao.com/*",
      "https://search.jd.com/*"
    ],
    action: {
      default_title: "BPA 状态"
    }
  }
});
