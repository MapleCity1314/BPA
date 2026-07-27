import { readDoudianShopContext } from "@bpa/adapter-doudian";

async function readShopContextWhenReady(): Promise<
  ReturnType<typeof readDoudianShopContext>
> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return readDoudianShopContext(document, location.href);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "PAGE_LOADING" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export default defineContentScript({
  matches: ["https://fxg.jinritemai.com/ffa/g/list*"],
  main() {
    browser.runtime.onMessage.addListener(
      (
        request: {
          type?: string;
          node?: { id?: string; version?: string };
          pageEpoch?: string;
        },
        _sender,
        sendResponse
      ) => {
        if (
          request.type !== "bpa.execute" ||
          request.node?.id !== "doudian.shop.context.read" ||
          request.node.version !== "1.0.0"
        ) {
          return undefined;
        }
        void readShopContextWhenReady()
          .then((context) => {
            sendResponse({
              ok: true,
              output: {
                ...context,
                page_epoch: request.pageEpoch
              }
            });
          })
          .catch((error: unknown) => {
            const code =
              error instanceof Error ? error.message : "ADAPTER_FAILED";
            sendResponse({
              ok: false,
              error: {
                code,
                message:
                  code === "PAGE_LOADING"
                    ? `店铺信息尚未加载完成（ready=${document.readyState}, headerCandidates=${document.querySelectorAll("[class*='headerShopName']").length}, path=${location.pathname}）。`
                    : "当前页面不是受支持的抖店商品列表页。",
                retryable: code === "PAGE_LOADING"
              }
            });
          });
        return true;
      }
    );
  }
});
