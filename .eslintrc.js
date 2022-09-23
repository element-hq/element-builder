module.exports = {
    plugins: [
        "matrix-org",
    ],
    extends: [
        "plugin:matrix-org/typescript",
    ],
    parserOptions: {
        tsconfigRootDir: __dirname,
        project: ["./tsconfig.json"],
    },
    env: {
        node: true,
    },
    rules: {
        // We aren't using ES modules here yet
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/no-non-null-assertion": "off",

        // Ensure we always explicitly access string representations
        "@typescript-eslint/no-base-to-string": "error",

        "quotes": "off",
    },
};
