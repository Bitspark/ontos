/*
 * Every case of projection/json/vectors/total.json against the ./total entry point
 * (ontos-total-json/1): reads, refusals with code, path, UTF-8 span and kind, writes,
 * write refusals, limits and the laws. The replay is in ./vectors.ts.
 */

import * as total from "../dist/src/total.js";
import { replay } from "./vectors.ts";

replay("total", total);
