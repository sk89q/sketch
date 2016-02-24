import random
import subprocess
import logging

__all__ = ('get_git_revision_hash',
           'create_hint',
           'PhraseChooser',)


def get_git_revision_hash():
    try:
        return subprocess.check_output(['git', 'describe', '--dirty', '--all', '--long']).decode('utf-8').strip()
    except Exception:
        logging.warning("Failed to get Git hash", exc_info=True)
        return "unknown"


def create_hint(phrase, reveal_length):
    words = phrase.split(" +")
    return ' '.join([w[:reveal_length] + '_' * (len(phrase) - reveal_length) for w in words])


class PhraseChooser(object):
    def __init__(self, word_list):
        self.word_list = word_list
        self.history = set()

    def next(self):
        return random.choice(self.word_list)