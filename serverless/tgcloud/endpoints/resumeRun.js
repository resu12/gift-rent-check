import {engine} from '../lib/runtime.js';
export default async function(input, ctx) {return engine.resumeRun(ctx, input);}
