// The single place the worker gets the verifier from. While task 6 isn't on main this re-exports the
// temporary exact-only stub; when src/shared/quote.ts exists, change this one line to
//   export * from '../shared/quote.js';
// and delete quote-stub.ts.
export * from './quote-stub.js';
