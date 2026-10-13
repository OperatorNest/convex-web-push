import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval("cleanup", { hours: 6 }, internal.cleanup.run, {});
export default crons;
