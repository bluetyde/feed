// parsePatchValue reads the value of a boundary patch from a written field. Plan 11 B0 found that a boundary condition with a sub-dictionary (the time tables of
// OFFBEAT's timeDependentAxialProfileHTC and timeDependentAxialProfileT) ends its block with a closing brace of the sub-dictionary first, which the old reader took for the end.
import { describe, expect, it } from "vitest";
import { parsePatchValue } from "../src/core/resultsParser";

const field = (cladOuter: string, after = "") => `boundaryField
{
    cladInner
    {
        type resistiveGap;
        value uniform 704.66836;
    }
    cladOuter
    {
${cladOuter}
    }
${after}}
`;

describe("parsePatchValue", () => {
  it("reads a plain patch", () => {
    expect(parsePatchValue(field("        type convectiveHTC;\n        value uniform 704.3889;"), "cladOuter")).toBe(704.3889);
    expect(parsePatchValue(field("        type convectiveHTC;\n        value uniform 704.3889;"), "cladInner")).toBe(704.66836);
  });
  it("reads the value of a patch that holds a sub-dictionary before it (the time tables of a time-dependent boundary)", () => {
    const block = `        type            timeDependentAxialProfileHTC;
        axialProfileDict 
        {
            timePoints      ( 0 10 10.05 40 );
            hData           ( ( 500 500 ) ( 100 100 ) );
            axialInterpolationMethod "linear";
        }
;
        T0              uniform 600;
        value           uniform 704.3889;`;
    expect(parsePatchValue(field(block), "cladOuter")).toBe(704.3889);
  });
  it("does not read a value that belongs to the next patch when its own has none", () => {
    expect(parsePatchValue(field("        type convectiveHTC;\n        T0 uniform 600;", "    cladFront\n    {\n        value uniform 111;\n    }\n"), "cladOuter")).toBeNull();
  });
  it("a block that never closes is unread, and a missing patch is unread", () => {
    expect(parsePatchValue("cladOuter\n{\n  value uniform 5;\n  sub { a 1; }\n", "cladOuter")).toBeNull();
    expect(parsePatchValue(field("        value uniform 5;"), "nothing")).toBeNull();
  });
  it("a value that is not finite is unread", () => {
    expect(parsePatchValue(field("        value uniform nan;"), "cladOuter")).toBeNull();
  });
});
