module.exports = {
    plugins: [
        "matrix-org",
    ],
    extends: [
        "plugin:matrix-org/typescript",
    ],
    env: {
        node: true,
    },
    rules: {
        // We aren't using ES modules here yet
        "@typescript-eslint/no-var-requires": "off",

        "quotes": "off",
    }
};
