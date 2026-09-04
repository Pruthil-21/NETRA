import logging

from app.logging_config import configure_logging, logger


def test_configure_logging_returns_info_level_logger():
    result = configure_logging()
    assert result.name == "netra"
    assert result.level == logging.INFO


def test_module_level_logger_is_the_same_object():
    assert logger.name == "netra"
    assert logger.level == logging.INFO
