import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('guard',Path(__file__).with_name('check-sbf-build-log.py'))
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)

class StackDiagnostics(unittest.TestCase):
    def test_actual_zero_exit_stack_corruption_message(self):
        self.assertTrue(guard.violations('Error: A function call in method match_chunk overwrites values in the frame. Please, decrease stack usage or remove parameters from the call.'))
    def test_stack_limit_diagnostic(self):
        self.assertTrue(guard.violations('Error: Stack offset of 5000 exceeded max offset of 4096 by 904 bytes'))
    def test_normal_compiler_output(self):
        self.assertEqual(guard.violations('Compiling tesoro_core\nFinished release profile'),[])

if __name__=='__main__':unittest.main()
