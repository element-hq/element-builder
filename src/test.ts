import logger from "./logger";

(async () => {
    logger.setup(
        "https://matrix.org",
        "!cCpRBTFuXwPmOCUFRL:matrix.org",
        "syt_d2ViZGV2Z3VydV9nb25lYg_USpYSJGOAhKqXvXBXqJY_1tAgn3",
    );

    logger.info("Test");
    const threadLogger = await logger.threadLogger();
    threadLogger.info("foobar1");
    threadLogger.info("foobar2");
    threadLogger.info("foobar3");
})();
