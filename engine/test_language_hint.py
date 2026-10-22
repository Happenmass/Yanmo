import unittest

from engine.language_hint import language_hint, prose


class LanguageHintTests(unittest.TestCase):
    def testSourceLanguageHintIsAvailableOffline(self):
        self.assertEqual(language_hint("今日はいい天気ですね。散歩に行きましょう。"), "ja")
        self.assertEqual(language_hint("Das Treffen findet morgen um 15 Uhr statt."), "de")

    def testCodeURLsAndNumbersAreNotLanguageEvidence(self):
        self.assertIsNone(language_hint("100"))
        self.assertIsNone(language_hint("`今日は晴れです` https://example.test/hello"))
        self.assertEqual(prose("Use `你好` and `今日は`."), "Use   and  .")
