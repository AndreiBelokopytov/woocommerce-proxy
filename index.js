require("dotenv").config();
const crypto = require("crypto");
const Koa = require("koa");
const Router = require("koa-router");
const bodyParser = require("koa-bodyparser");
const cors = require("@koa/cors");
const WooCommerce = require("woocommerce-api");
const MemoryCache = require("@mediaxpost/memory-cache");

const app = new Koa();
app.use(bodyParser());
const router = new Router();
const client = new MemoryCache({ bypassUnsupported: true });
client.createClient();

let cacheVersion = Date.now();

const {
  WOOCOMMERCE_SITE_URL,
  WOOCOMMERCE_API_KEY,
  WOOCOMMERCE_API_SECRET,
  WOOCOMMERCE_WEBHOOK_SECRET,
  CACHE_TTL,
  PORT,
  NODE_ENV
} = process.env;

const wooCommerce = new WooCommerce({
  url: WOOCOMMERCE_SITE_URL,
  consumerKey: WOOCOMMERCE_API_KEY,
  consumerSecret: WOOCOMMERCE_API_SECRET,
  wpAPI: true,
  version: "wc/v2",
  queryStringAuth: true
});

function getWPTotal(headers) {
  const wpTotal = {};
  if ("x-wp-total" in headers) {
    wpTotal.total = parseInt(headers["x-wp-total"], 10);
  }
  if ("x-wp-totalpages" in headers) {
    wpTotal.pages = parseInt(headers["x-wp-totalpages"], 10);
  }
  return wpTotal;
}

async function handleWooCommerceResponse(url) {
  const response = await wooCommerce.getAsync(url);
  if (response.statusCode !== 200) {
    throw new Error(
      `Invalid response status for url /${url}: ${response.statusCode} ${
        response.statusMessage
      }`
    );
  }
  let results;
  try {
    results = JSON.parse(response.body);
  } catch (e) {
    throw new Error(`Invalid response body for url /${url}: ${response.body}`);
  }

  const wpTotal = getWPTotal(response.headers);
  return Object.assign({}, { results }, wpTotal);
}

function wooCommerceProxyGet(url, urlParams, ttl = false) {
  return async function(ctx, next) {
    const path = urlParams
      ? urlParams.map(item => ctx.params[item]).join("/")
      : null;
    let fullUrl = path ? url + "/" + path : url;
    fullUrl = ctx.search ? fullUrl + ctx.search : fullUrl;
    let response = client.get(fullUrl);
    if (!response) {
      try {
        response = await handleWooCommerceResponse(fullUrl);
        ctx.body = response;
        ctx.status = 200;
        client.set(fullUrl, JSON.stringify(response));
        if (ttl) {
          client.expire(fullUrl, CACHE_TTL);
        }
        next();
      } catch (err) {
        ctx.throw(500, "Internal server error");
        next();
      }
    } else {
      ctx.body = JSON.parse(response);
      next();
    }
  };
}

async function setQueryContext(ctx, next) {
  ctx.query = Object.assign({}, ctx.query, {
    context: "view"
  });

  await next();
}

async function setCacheVersion(context, next) {
  context.body.cacheVersion = cacheVersion;
  next();
}

async function cleanCache(ctx, next) {
  const topic = ctx.headers["x-wc-webhook-topic"];
  const signature = ctx.headers["x-wc-webhook-signature"];
  console.log("WebHook accepted, topic:", topic);
  const { rawBody } = ctx.request;
  if (!signature || !rawBody) {
    return next();
  }
  const encrypt = crypto
    .createHmac("sha256", WOOCOMMERCE_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  if (encrypt !== signature) {
    return next();
  }
  client.flushdb();
  cacheVersion = Date.now();
  console.log("Cache flushed");
  ctx.status = 200;
  next();
}

router.get("/", (ctx, next) => {
  ctx.body = "WooCommerce Proxy Server";
  next();
});

router.get(
  "/products",
  setQueryContext,
  wooCommerceProxyGet("products"),
  setCacheVersion
);

router.get(
  "/categories",
  setQueryContext,
  wooCommerceProxyGet("products/categories", null, true),
  setCacheVersion
);

router.get(
  "/products/:id",
  wooCommerceProxyGet("products", ["id"]),
  setCacheVersion
);

router.post("/clean-cache", cleanCache);

app
  .use(router.routes())
  .use(router.allowedMethods())
  .use(cors());

app.on("error", err => {
  console.log(">>>> Server error");
  console.log(err.message);
  console.log(err.stack);
  console.log("====");
});

if (NODE_ENV === "development") {
  app.listen(PORT);
  console.log("Proxy server started");
} else {
  module.exports = app.callback();
}
