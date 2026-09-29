import { openDatabase } from "../../src/db.js";
import { redeemGenesis } from "../../src/genesis/service.js";
import { spinSlot } from "../../src/slot/service.js";
import { EconomyError } from "../../src/tide/ledger.js";
const [path,action,value,userId]=process.argv.slice(2);
const db=openDatabase(path!);
try {
  const r=action==="redeem"?redeemGenesis(db,userId||"bob",value!):spinSlot(db,userId||"alice",value!,()=>[0,0,0]);
  console.log(JSON.stringify({ok:true,balance:r.balance}));
}catch(e){if(e instanceof EconomyError)console.log(JSON.stringify({ok:false}));else throw e;}finally{db.close();}
