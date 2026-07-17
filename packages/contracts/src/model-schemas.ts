/**
 * Effect Schema model enums with parse/safeParse API (no cycle with model.ts constants).
 */
import {
  modelModalitySchema as _mod,
  modelModalitiesSchema as _mods,
  modelStatusSchema as _status,
} from "./effect/model.ts";
import { withParseApi } from "./parse.ts";

export const modelModalitySchema = withParseApi(_mod);
export const modelModalitiesSchema = withParseApi(_mods);
export const modelStatusSchema = withParseApi(_status);
