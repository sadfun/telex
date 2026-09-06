import { maintainWirebot } from "./wirebot.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing Wirebot instance directory");
await maintainWirebot(directory);
