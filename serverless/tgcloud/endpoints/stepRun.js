import {engine} from '../lib/runtime.js';
export default async function(input, ctx) {return engine.stepRun(ctx, input);}
