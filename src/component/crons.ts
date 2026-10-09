import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval("cleanup old push data", { hours: 6 }, internal.cleanup.run, {});
export default crons;
