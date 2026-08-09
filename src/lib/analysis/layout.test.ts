import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseLayout, type LayoutJson } from "./layout";

function loadLayout(name: string): LayoutJson {
  const file = path.join(process.cwd(), "public", "data", "layouts", `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

const qwerty = parseLayout(loadLayout("qwerty"));
const dvorak = parseLayout(loadLayout("dvorak"));

describe("parseLayout / charToKey", () => {
  it("maps lowercase and shifted characters to the same physical key", () => {
    expect(qwerty.charToKey("a")).toBe("a");
    expect(qwerty.charToKey("A")).toBe("a");
  });

  it("returns undefined for a character not present in the layout", () => {
    expect(qwerty.charToKey("é")).toBeUndefined();
  });

  it("maps the space row correctly (no shifted variant)", () => {
    expect(qwerty.charToKey(" ")).toBe(" ");
  });
});

describe("keyToFinger — standard touch-typing assignment by column", () => {
  it("assigns home-row keys to the standard fingers", () => {
    expect(qwerty.keyToFinger("a")).toBe("l-pinky");
    expect(qwerty.keyToFinger("s")).toBe("l-ring");
    expect(qwerty.keyToFinger("d")).toBe("l-middle");
    expect(qwerty.keyToFinger("f")).toBe("l-index");
    expect(qwerty.keyToFinger("g")).toBe("l-index");
    expect(qwerty.keyToFinger("h")).toBe("r-index");
    expect(qwerty.keyToFinger("j")).toBe("r-index");
    expect(qwerty.keyToFinger("k")).toBe("r-middle");
    expect(qwerty.keyToFinger("l")).toBe("r-ring");
    expect(qwerty.keyToFinger(";")).toBe("r-pinky");
  });

  it("assigns space to thumb", () => {
    expect(qwerty.keyToFinger(" ")).toBe("thumb");
  });

  it("returns undefined for an unknown key", () => {
    expect(qwerty.keyToFinger("not-a-key")).toBeUndefined();
  });

  it("derives finger from physical column position, not character identity", () => {
    // 'a' sits at row3/col0 in both layouts (same physical key) -> same finger.
    expect(dvorak.keyToFinger("a")).toBe(qwerty.keyToFinger("a"));
    // 'd' is row3/col2 in qwerty (l-middle) but row3/col5 in dvorak (r-index)
    // — same character, different physical position, different finger.
    expect(qwerty.keyToFinger("d")).toBe("l-middle");
    expect(dvorak.keyToFinger("d")).toBe("r-index");
  });
});

describe("keyToRow", () => {
  it("returns the correct row label", () => {
    expect(qwerty.keyToRow("q")).toBe("row2");
    expect(qwerty.keyToRow("a")).toBe("row3");
    expect(qwerty.keyToRow("z")).toBe("row4");
    expect(qwerty.keyToRow("1")).toBe("row1");
    expect(qwerty.keyToRow(" ")).toBe("row5");
  });

  it("returns undefined for an unknown key", () => {
    expect(qwerty.keyToRow("not-a-key")).toBeUndefined();
  });
});

describe("areAdjacent", () => {
  it("is true for horizontally adjacent keys on the same row", () => {
    expect(qwerty.areAdjacent("a", "s")).toBe(true);
  });

  it("is true for vertically adjacent keys on neighbouring rows", () => {
    expect(qwerty.areAdjacent("a", "q")).toBe(true);
  });

  it("is false for a key and itself", () => {
    expect(qwerty.areAdjacent("a", "a")).toBe(false);
  });

  it("is false for distant keys", () => {
    expect(qwerty.areAdjacent("a", "p")).toBe(false);
  });

  it("is false when either key is unresolved", () => {
    expect(qwerty.areAdjacent("a", "not-a-key")).toBe(false);
  });
});

describe("isSameFinger", () => {
  it("is true for two keys sharing a finger", () => {
    expect(qwerty.isSameFinger("f", "g")).toBe(true);
  });

  it("is false for two keys on different fingers", () => {
    expect(qwerty.isSameFinger("a", "s")).toBe(false);
  });

  it("is true trivially for the same key typed twice", () => {
    expect(qwerty.isSameFinger("a", "a")).toBe(true);
  });

  it("is false when either key is unresolved", () => {
    expect(qwerty.isSameFinger("a", "not-a-key")).toBe(false);
  });
});
