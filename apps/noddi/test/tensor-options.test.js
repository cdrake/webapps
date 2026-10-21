import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TENSOR_FITS } from "@neurodesk/noddi/pipeline";

test("the tensor-fit options agree in the page, the automation schema and the pipeline", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const select = html.match(/<select id="tensorFit">([\s\S]*?)<\/select>/)[1];
  const options = [...select.matchAll(/<option value="([^"]+)"( selected)?/g)];
  assert.deepEqual(options.map((m) => m[1]), [...TENSOR_FITS]);
  assert.deepEqual(options.filter((m) => m[2]).map((m) => m[1]), ["wls"]);
  const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
  const parameter = automation.operations.fit.parameters.tensorFit;
  assert.deepEqual(parameter.enum, [...TENSOR_FITS]);
  assert.equal(parameter.default, "wls");
});
