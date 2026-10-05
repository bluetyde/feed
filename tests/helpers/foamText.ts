// Format cell values as OpenFOAM field files, so saved compact results can be fed back through the real parser.
export const scalarFieldText = (values: number[], wall?: number): string =>
  `FoamFile\n{\n    class volScalarField;\n    object T;\n}\n\ndimensions [0 0 0 1 0 0 0];\n\ninternalField   nonuniform List<scalar> \n${values.length}\n(\n${values.join("\n")}\n)\n;\n\nboundaryField\n{\n    cladOuter\n    {\n        type fixedValue;\n        value uniform ${wall ?? 300};\n    }\n}\n\n\n// ************************************************************************* //\n`;
export const vectorFieldText = (r: number[]): string =>
  `FoamFile\n{\n    class volVectorField;\n    object C;\n}\n\ndimensions [0 1 0 0 0 0 0];\n\ninternalField   nonuniform List<vector> \n${r.length}\n(\n${r.map((x) => `(${x} 0 0.5)`).join("\n")}\n)\n;\n\n\n// ************************************************************************* //\n`;
