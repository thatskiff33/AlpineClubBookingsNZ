import Script from "next/script";

const SNZ_WIDGET_SCRIPT_URL =
  "https://snowhq.com/widget-embeds/client/dist/widget.min.js";
const SNZ_WIDGET_ENDPOINT_PREFIX = "https://snowhq.com/widget/";

export function SkifieldConditionsWidget({ dataHash }: { dataHash?: string }) {
  const hash = dataHash?.trim();

  if (!hash || !/^[a-f0-9]{32}$/.test(hash)) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <strong>Ski field conditions widget:</strong> a 32-character hex hash is
        required. Use{" "}
        <code className="font-mono">
          {"{{skifield-conditions:your-hash-here}}"}
        </code>
      </div>
    );
  }

  return (
    <>
      <div className="js-snz-widget" data-hash={hash} />
      <Script
        id="snz-widget-fetch-proxy"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            (function () {
              if (typeof window === 'undefined' || window.__snzFetchProxyInstalled) {
                return;
              }

              var originalFetch = window.fetch && window.fetch.bind(window);
              if (!originalFetch) {
                return;
              }

              window.__snzFetchProxyInstalled = true;

              window.fetch = function (input, init) {
                try {
                  var url = '';

                  if (typeof input === 'string') {
                    url = input;
                  } else if (input && typeof input.url === 'string') {
                    url = input.url;
                  }

                  if (url.indexOf('${SNZ_WIDGET_ENDPOINT_PREFIX}') === 0) {
                    var widgetHash = url.slice('${SNZ_WIDGET_ENDPOINT_PREFIX}'.length).replace(/\/$/, '');

                    if (/^[a-f0-9]{32}$/i.test(widgetHash)) {
                      return originalFetch('/api/skifield-conditions?hash=' + encodeURIComponent(widgetHash), init);
                    }
                  }
                } catch (e) {
                }

                return originalFetch(input, init);
              };
            })();
          `,
        }}
      />
      <Script
        id="snzwidget"
        src={SNZ_WIDGET_SCRIPT_URL}
        strategy="afterInteractive"
      />
    </>
  );
}
