const fs=require('fs'),vm=require('vm'),assert=require('assert');const src=fs.readFileSync(require('path').join(__dirname,'../server.js'),'utf8');
async function run(route,errors=[],noDb=false){let handler,attempts=0;const cache=new Map();const start=src.indexOf("app.post('"+route+"'");const end=src.indexOf('\n});',start)+4;
const ctx=vm.createContext({process:{env:{}},console:{error(){}},authenticateUser(){},app:{post:(path,auth,h)=>handler=h},publicPayBase:()=> 'https://pay.example.invalid',generateShortCode:()=> 'code000'+attempts,shortLinks:cache,paymentSessions:new Map(),stripe:{prices:{create:async()=>({id:'price_test'})},paymentLinks:{create:async()=>({id:'plink_test',url:'https://buy.stripe.com/test'})}},supabase:noDb?null:{from:()=>({insert:async()=>({error:errors[attempts++]||null})})}});
vm.runInContext(src.slice(start,end),ctx);
const res={statusCode:200,status(n){this.statusCode=n;return this},json(data){this.data=data;return this}};
await handler({body:{amount:100},protocol:'https',get:()=> 'pay.example.invalid'},res);assert.equal(res.statusCode,200);return{res,cache,attempts};}
(async()=>{for(const route of ['/api/create-checkout-session','/api/create-payment-link']){
let r=await run(route);assert(r.res.data.paymentUrl.endsWith('/code0000'));assert.equal(r.cache.size,1);
r=await run(route,[{code:'XX000',message:'database unavailable'}]);assert(r.res.data.paymentUrl.endsWith('/pay/invoice/plink_test'));assert.equal(r.cache.size,0);
r=await run(route,[],true);assert(r.res.data.paymentUrl.endsWith('/pay/invoice/plink_test'));assert.equal(r.cache.size,0);
r=await run(route,Array(3).fill({code:'23505'}));assert.equal(r.attempts,3);assert(r.res.data.paymentUrl.endsWith('/pay/invoice/plink_test'));assert.equal(r.cache.size,0);
r=await run(route,[{code:'23505'},null]);assert.equal(r.attempts,2);assert(r.res.data.paymentUrl.endsWith('/code0001'));}
console.log('PASS: both creation endpoints return persisted short URLs or durable Stripe-ID routes, including database outages and collisions.');})().catch(e=>{console.error(e);process.exitCode=1});
