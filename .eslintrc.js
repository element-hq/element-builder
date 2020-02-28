const jsSdkEslintCfg = require('matrix-js-sdk/.eslintrc');

module.exports = {
    parser: "babel-eslint",
    parserOptions: {
        ecmaVersion: 8,
    },
    env: {
        es6: true,
        node: true,
    },
    extends: ["eslint:recommended", "google"],
    plugins: ['babel'],
    rules: jsSdkEslintCfg.rules,
}

// also override the line length to be consistent with
// vector-web / react-sdk rather than js-sdk
module.exports.rules["max-len"] = ["warn", {
    code: 120,
}];
