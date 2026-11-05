import http from 'node:http'
const page = `<!doctype html><html><head><title>Acme checkout</title><style>
body{margin:0;font:14px system-ui,sans-serif;color:#1b1e25;background:#fff}
nav{display:flex;gap:22px;align-items:center;height:52px;padding:0 28px;border-bottom:1px solid #e8e8ec}
nav b{margin-right:auto;font-size:16px} nav a{color:inherit;text-decoration:none}
main{display:grid;grid-template-columns:1fr 280px;gap:28px;padding:26px 28px}
h1{font-size:22px;margin:0 0 14px} input{display:block;width:100%;box-sizing:border-box;height:36px;margin-bottom:10px;padding:0 10px;border:1px solid #d8d8de}
.card{border:1px solid #e8e8ec;padding:16px;align-self:start}.line{display:flex;justify-content:space-between;margin-bottom:8px}
button.pay{display:block;width:100%;margin-top:30px;padding:11px;background:#30a46c;color:#fff;border:0;font-weight:600;cursor:pointer}
</style></head><body><nav><b>Acme</b><a href="#shop">Shop</a><a href="#orders">Orders</a><a href="#help">Help</a></nav>
<main><form onsubmit="return false"><h1>Checkout</h1><input id="email" placeholder="Email"><input id="card" placeholder="Card number"><input id="name" placeholder="Name on card"></form>
<aside class="card"><div class="line"><span>Subtotal</span><span>$84.00</span></div><div class="line"><span>Shipping</span><span>$6.00</span></div><div class="line"><b>Total</b><b>$90.00</b></div><button class="pay">Pay now</button></aside></main></body></html>`
http.createServer((_q, s) => { s.setHeader('content-type', 'text/html'); s.end(page) }).listen(5199, '127.0.0.1', () => console.log('fixture up'))
