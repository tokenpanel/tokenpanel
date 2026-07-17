/**
 * Deep-mutable view of Effect Schema.Type output.
 * Effect Struct fields are readonly; Mongo/API code mutates filters and docs.
 * Optional keys also accept explicit `undefined` (exactOptionalPropertyTypes).
 */
import type { ObjectId } from "mongodb";

type OptionalKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;

export type MutableDeep<T> = T extends Date
  ? T
  : T extends ObjectId
    ? T
    : T extends RegExp
      ? T
      : T extends (...args: never[]) => unknown
        ? T
        : T extends readonly (infer U)[]
          ? MutableDeep<U>[]
          : T extends object
            ? {
                -readonly [K in RequiredKeys<T>]: MutableDeep<T[K]>;
              } & {
                -readonly [K in OptionalKeys<T>]?:
                  | MutableDeep<Exclude<T[K], undefined>>
                  | undefined;
              }
            : T;
