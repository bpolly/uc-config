import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { isObject } from "./util.js";
import type { ObjectValue } from "./model.js";
export const spec = JSON.parse(
  readFileSync(new URL("../vendor/core-api.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: false,
});
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
// Authoring-time secret references are legal where a native string is expected.
// Resolved values are validated again immediately before writes.
function symbolicSchema(value: any): any {
  if (Array.isArray(value)) return value.map(symbolicSchema);
  if (!value || typeof value !== "object") return value;
  const node = Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, symbolicSchema(v)]),
  );
  if (value.type === "string")
    return {
      anyOf: [
        node,
        {
          type: "object",
          properties: {
            $secret: { type: "string", pattern: "^(env|keychain):.+$" },
            version: { type: "string" },
          },
          required: ["$secret"],
          additionalProperties: false,
        },
      ],
    };
  return node;
}
ajv.addSchema({ ...symbolicSchema(spec), $id: "uc" }, "uc");
export function validateRequest(
  path: string,
  method: string,
  data: unknown,
): void {
  const schema =
    spec.paths[path]?.[method.toLowerCase()]?.requestBody?.content?.[
      "application/json"
    ]?.schema;
  if (!schema) return;
  const id = `uc#/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${method.toLowerCase()}/requestBody/content/application~1json/schema`;
  const validate = ajv.getSchema(id) ?? ajv.compile({ $ref: id });
  if (!validate(data))
    throw new Error(
      `Invalid ${method} ${path}: ${ajv.errorsText(validate.errors, { dataVar: "body" })}`,
    );
}
export function writable(
  path: string,
  method: string,
  value: ObjectValue,
): ObjectValue {
  const root =
    spec.paths[path]?.[method]?.requestBody?.content?.["application/json"]
      ?.schema;
  function properties(schema: any): Record<string, any> {
    if (!schema) return {};
    if (schema.$ref)
      return properties(
        schema.$ref
          .split("/")
          .slice(1)
          .reduce((a: any, k: string) => a[k], spec),
      );
    return {
      ...schema.properties,
      ...Object.assign({}, ...(schema.allOf ?? []).map(properties)),
    };
  }
  function pick(schema: any, v: ObjectValue): ObjectValue {
    const props = properties(schema);
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k in props)
        .map(([k, x]) => [
          k,
          isObject(x) && Object.keys(properties(props[k])).length
            ? pick(props[k], x)
            : x,
        ]),
    );
  }
  return pick(root, value);
}
