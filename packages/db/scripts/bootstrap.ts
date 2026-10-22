#!/usr/bin/env node
/** db:bootstrap —— 空库一键建表（详见 src/bootstrap.ts） */
import { bootstrapDb } from "../src/bootstrap.js";

await bootstrapDb();
console.log("✔ bootstrap 完成");
