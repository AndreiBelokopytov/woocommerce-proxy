require("dotenv").config();
const Koa = require("koa");
const WooCommerce = require("woocommerce-api");
const Router = require("koa-router");
const cors = require("@koa/cors");
const MemoryCache = require("@mediaxpost/memory-cache");

const app = new Koa();
const router = new Router();
const client = new MemoryCache({ bypassUnsupported: true });
client.createClient();

const TTL = 600;

const wooCommerce = new WooCommerce({
  url: process.env.WOOCOMMERCE_SITE_URL,
  consumerKey: process.env.WOOCOMMERCE_API_KEY,
  consumerSecret: process.env.WOOCOMMERCE_API_SECRET,
  wpAPI: true,
  version: "wc/v2"
});

function getWPTotal(headers) {
  const wpTotal = {};
  if (headers.hasOwnProperty("x-wp-total")) {
    wpTotal.total = parseInt(headers["x-wp-total"], 10);
  }
  if (headers.hasOwnProperty("x-wp-totalpages")) {
    wpTotal.pages = parseInt(headers["x-wp-totalpages"], 10);
  }
  return wpTotal;
}

async function handleWooCommerceResponse(url) {
  const response = await wooCommerce.getAsync(url);
  const results = JSON.parse(response.body);
  const wpTotal = getWPTotal(response.headers);
  return Object.assign({}, { results }, wpTotal);
}

function wooCommerceProxyGet(url, urlParams) {
  return async function(ctx, next) {
    const path = urlParams
      ? urlParams.map(item => ctx.params[item]).join("/")
      : null;
    const fullUrl = path ? url + "/" + path : url;
    let response = client.get(fullUrl);
    if (!response) {
      try {
        response = await handleWooCommerceResponse(fullUrl);
        ctx.body = response;
        client.set(fullUrl, JSON.stringify(response));
        client.expire(fullUrl, TTL);
        next();
      } catch (err) {
        if (err.response && err.response.statusCode) {
          ctx.throw(err.response.statusCode, err.message);
        } else {
          throw err;
        }
        next();
      }
    } else {
      ctx.body = JSON.parse(response);
      next();
    }
  };
}

router.get("/", (ctx, next) => {
  ctx.body = "WooCommerce Proxy Server";
  next();
});

router.get("/products", wooCommerceProxyGet("products"));

router.get("/categories", wooCommerceProxyGet("products/categories"));

router.get("/products/:id", wooCommerceProxyGet("products", ["id"]));

app
  .use(router.routes())
  .use(router.allowedMethods())
  .use(cors());

app.on("error", (err, ctx) => {
  console.log("server error", err, ctx);
});

if (process.env.NODE_ENV === "development") {
  app.listen(process.env.PORT);
  console.log("Proxy server started");
} else {
  module.exports = app.callback();
}
