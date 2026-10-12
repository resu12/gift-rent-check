// Shared website traffic accounting. Only fixed request IDs, account scopes
// and times are retained; cookies, proofs, URLs and provider bodies are absent.
export const MARKETAPP_WEBSITE_LIMITS = Object.freeze({owner_attempts:100, service_attempts:100, window_ms:86400000, interval_ms:1000, lease_ms:150000});
const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value);
const timestamp=value=>Number.isSafeInteger(value)&&value>0&&value<8640000000000000-86400000;
export function createMarketappWebsiteGate(db,{scopeFor=owner=>`private:${owner}`,access=async()=>true,limits=MARKETAPP_WEBSITE_LIMITS}={}) {
  async function scope(owner) {if(!/^[1-9]\d{0,19}$/.test(String(owner))||!await access(String(owner)))throw new Error('Website account unavailable');return scopeFor(String(owner));}
  const retry=(at,deadline,reason)=>({allowed:false,reason,retry_at:new Date(Math.max(at+1,deadline)).toISOString(),retry_after_seconds:Math.max(1,Math.ceil((deadline-at)/1000))});
  return {
    async acquireMarketappWebsiteLease(owner,id,at,duration=limits.lease_ms) {
      const key=await scope(owner);if(!safeId(id)||!timestamp(at)||!Number.isSafeInteger(duration)||duration<1000||duration>limits.lease_ms)throw new Error('Invalid website lease');
      const result=await db.run(`INSERT INTO marketapp_website_gates(scope_key,lease_id,lease_until,next_allowed_at)
        VALUES(:scope,:id,:until,0) ON CONFLICT(scope_key) DO UPDATE SET lease_id=:id,lease_until=:until
        WHERE marketapp_website_gates.lease_until<=:at`,{':scope':key,':id':id,':until':at+duration,':at':at});
      return result.rowsAffected===1?{id,expires_at:at+duration}:null;
    },
    async releaseMarketappWebsiteLease(owner,lease) {
      const key=await scope(owner);if(!safeId(lease?.id))return false;
      return (await db.run(`UPDATE marketapp_website_gates SET lease_id=NULL,lease_until=0 WHERE scope_key=:scope AND lease_id=:id AND lease_until=:until`,{':scope':key,':id':lease.id,':until':lease.expires_at})).rowsAffected===1;
    },
    async reserveMarketappWebsiteRequest(owner,lease,id,at,{authentication=false}={}) {
      const key=await scope(owner);if(!safeId(lease?.id)||!safeId(id)||!timestamp(at))throw new Error('Invalid website request');
      // TON proof exchange is one existing bounded login flow, whose three
      // fixed requests cannot be suspended between wallet approval and save
      // on the timerless Telegram runtime. This server-only exception remains
      // quota/deadline accounted and cannot pace any personal-gifts request.
      const burst=authentication===true&&/^[0-9a-f]{64}_(?:prepare|finish)$/.test(lease.id)&&
        /^(?:[0-9a-f]{64})_(?:home|auth|analytics)$/.test(id)&&id.slice(0,64)===lease.id.slice(0,64);
      await db.run('DELETE FROM marketapp_website_requests WHERE attempted_at<=:before',{':before':at-limits.window_ms});
      const result=await db.run(`INSERT OR IGNORE INTO marketapp_website_requests(request_id,scope_key,attempted_at)
        SELECT :id,:scope,:at WHERE EXISTS(SELECT 1 FROM marketapp_website_gates WHERE scope_key=:scope AND lease_id=:lease AND lease_until=:lease_until AND lease_until>:at AND next_allowed_at<=:at)
        AND NOT EXISTS(SELECT 1 FROM marketapp_website_gates WHERE scope_key='service' AND next_allowed_at>:at)
        AND (:burst=1 OR NOT EXISTS(SELECT 1 FROM marketapp_website_requests WHERE attempted_at>:pace))
        AND (SELECT count(*) FROM marketapp_website_requests WHERE scope_key=:scope AND attempted_at>:before)<:owner_limit
        AND (SELECT count(*) FROM marketapp_website_requests WHERE attempted_at>:before)<:service_limit`,{
        ':id':`${key}:${id}`,':scope':key,':at':at,':lease':lease.id,':lease_until':lease.expires_at,':pace':at-limits.interval_ms,
        ':before':at-limits.window_ms,':owner_limit':limits.owner_attempts,':service_limit':limits.service_attempts,':burst':burst?1:0});
      if(result.rowsAffected===1)return {allowed:true};
      const active=await db.get('SELECT lease_id,lease_until,next_allowed_at FROM marketapp_website_gates WHERE scope_key=:scope',{':scope':key});
      if(active?.lease_id!==lease.id||active.lease_until!==lease.expires_at||active.lease_until<=at)return retry(at,active?.lease_until||at+1000,'busy');
      // Replaying a reserved request is never permission to send it twice.
      if(await db.get('SELECT 1 AS present FROM marketapp_website_requests WHERE request_id=:id',{':id':`${key}:${id}`}))return retry(at,at+1000,'replay');
      const ownerRows=await db.all('SELECT attempted_at FROM marketapp_website_requests WHERE scope_key=:scope AND attempted_at>:before ORDER BY attempted_at DESC LIMIT :limit',{':scope':key,':before':at-limits.window_ms,':limit':limits.owner_attempts});
      const serviceRows=await db.all('SELECT attempted_at FROM marketapp_website_requests WHERE attempted_at>:before ORDER BY attempted_at DESC LIMIT :limit',{':before':at-limits.window_ms,':limit':limits.service_attempts});
      const service=await db.get("SELECT next_allowed_at FROM marketapp_website_gates WHERE scope_key='service'");
      const ownerDaily=ownerRows.length>=limits.owner_attempts?ownerRows[ownerRows.length-1].attempted_at+limits.window_ms:0;
      const serviceDaily=serviceRows.length>=limits.service_attempts?serviceRows[serviceRows.length-1].attempted_at+limits.window_ms:0;
      const deadline=Math.max(active.next_allowed_at||0,service?.next_allowed_at||0,ownerDaily,serviceDaily,(serviceRows[0]?.attempted_at||0)+limits.interval_ms);
      return retry(at,deadline,Math.max(ownerDaily,serviceDaily)>=deadline?'daily':'cooldown');
    },
    async deferMarketappWebsiteRequests(owner,lease,until,at) {
      const key=await scope(owner);if(!safeId(lease?.id)||!timestamp(at)||!timestamp(until)||until<=at)throw new Error('Invalid website retry deadline');
      // Never let an obsolete response alter a new owner's traffic gate.
      const active=await db.get('SELECT 1 AS valid FROM marketapp_website_gates WHERE scope_key=:scope AND lease_id=:lease AND lease_until=:until AND lease_until>:at',{':scope':key,':lease':lease.id,':until':lease.expires_at,':at':at});
      if(!active)return false;
      await db.run("INSERT INTO marketapp_website_gates(scope_key,lease_id,lease_until,next_allowed_at) VALUES('service',NULL,0,:until) ON CONFLICT(scope_key) DO UPDATE SET next_allowed_at=MAX(next_allowed_at,:until)",{':until':until});
      await db.run('UPDATE marketapp_website_gates SET next_allowed_at=MAX(next_allowed_at,:until) WHERE scope_key=:scope AND lease_id=:lease',{':scope':key,':lease':lease.id,':until':until});
      return true;
    },
  };
}
