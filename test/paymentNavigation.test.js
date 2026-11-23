const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(require('path').join(__dirname,'../server.js'),'utf8');
const start=src.indexOf('const ALLOWED_ORIGINS ='),end=src.indexOf('// Webhook route MUST',start);let handler,restricted=0;
const context=vm.createContext({process:{env:{}},cors:opts=>(req,res,next)=>{restricted++;opts.origin(req.headers.origin,(error,allowed)=>{if(allowed)res.headers['access-control-allow-origin']=req.headers.origin;next(error);})},app:{use:fn=>{handler=fn}}});
vm.runInContext(src.slice(start,end),context);
function request(method,path,origin){let error;const res={headers:{}};handler({method,path,headers:{origin}},res,e=>{error=e});return{error,headers:res.headers}}
for(const path of ['/GNdH9DwN','/pay/GNdH9DwN','/pay/invoice/plink_example','/payment-success','/payment-cancelled'])for(const origin of ['null','https://mail.example.invalid',undefined])for(const method of ['GET','HEAD']){const r=request(method,path,origin);assert(!r.error,path);assert.deepEqual(r.headers,{},'Public navigation must not grant cross-origin credential access');}
assert.equal(restricted,0);
for(const [method,path] of [['POST','/api/create-payment-link'],['GET','/api/payments'],['POST','/GNdH9DwN'],['OPTIONS','/api/payments'],['GET','/pay/invoice/not-a-valid-link']]){assert(request(method,path,'null').error);assert(request(method,path,'https://evil.example').error);}
assert(!request('POST','/api/create-payment-link','https://pool-authority.vercel.app').error);
console.log('PASS: public payment navigation accepts opaque origins; API origin restrictions remain enforced; no new cross-origin read permissions.');
