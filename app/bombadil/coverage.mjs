// bombadil trace --json emits one record per observed state. Ignore the initial state's null action.
import { createInterface } from "node:readline";

const routes = new Set();
const controls = new Set();
let clicks = 0;
let actions = 0;
let states = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { metadata } = JSON.parse(line);
  states++;
  routes.add(new URL(metadata.state.url).pathname);
  if (!metadata.action) continue;
  actions++;
  const target = metadata.action.Click?.fingerprint;
  if (!target) continue;
  clicks++;
  if (target.tag !== "a") {
    controls.add(target.accessible_name ?? target.text_content ?? target.id ?? target.tag);
  }
}
console.log(`${states} states, ${actions} actions, ${clicks} clicks. Routes: ${[...routes].join(", ")}`);
console.log(`Controls clicked: ${[...controls].join(", ")}`);
const missing = process.argv.slice(2).map(route => "/" + route.split("?")[0]).filter(path => !routes.has(path));
if (missing.length || !controls.size) {
  throw new Error(`Incomplete exploration: missing routes [${missing.join(", ")}], controls clicked ${controls.size}`);
}
