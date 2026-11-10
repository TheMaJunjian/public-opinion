import type { RequestHandler } from 'express';
import type { Store } from './db.js';
import { currentSessionUserId } from './auth.js';
import { sanitizeModeration, withModerationViewer } from './moderation-visibility.js';

export function moderationHttp(store:Store):RequestHandler {
  return (req,res,next)=>{void (async()=>{
    const viewer=await currentSessionUserId(store,req);
    res.locals.reviewViewer=viewer;
    res.locals.reviewSanitize=(data:unknown)=>sanitizeModeration(store,data,viewer);
    const json=res.json.bind(res);
    res.set('Cache-Control','private, no-store');
    res.json=((data:unknown)=>{if(res.statusCode>=400)return json(data);void store.db.detachedRead(()=>sanitizeModeration(store,data,viewer)).then(clean=>json(clean)).catch(next);return res;}) as typeof res.json;
    withModerationViewer(viewer,next);
  })().catch(next);};
}
