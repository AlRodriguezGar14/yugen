"""Exercise the shipped launcher with fake tools; no network, installs, or real devices."""
import json
import gzip
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

LAUNCHER = Path(__file__).resolve().parents[1] / "scripts/start-dev.sh"
REAL_PGREP = shutil.which("pgrep")

# All external startup tools log their environment and act only inside the fixture.
FAKE_TOOL = r"""#!PYTHON
import json, os, subprocess, sys, time
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
root = Path(os.environ['QA_ROOT'])
mode = os.environ['QA_MODE']
state = root / 'state'
with (root / 'events.jsonl').open('a') as log:
    log.write(json.dumps({'tool': name, 'args': args, 'ai': os.getenv('YUGEN_AI_ENABLED'),
                          'key_present': 'OPENAI_API_KEY' in os.environ}) + '\n')
reused = mode.startswith('reuse') or mode == 'foreign-metro'
if name == 'curl':
    if ':8081/status' in args[-1]:
        print('packager-status:running' if reused or (state / 'metro').exists() else '', end='')
    elif '--data' in args:
        if '--output' in args:
            Path(args[args.index('--output') + 1]).write_text(json.dumps({
                'contractVersion': 2, 'language': 'ja', 'normalizedText': '米', 'tokens': [{'kanjiDetails': [{'character': '米', 'meanings': ['rice']}]}]}))
        print('404' if mode == 'foreign-analysis' else '200' if reused else '000', end='')
    else:
        print('405' if reused or (state / 'analysis').exists() else '000', end='')
elif name == 'lsof':
    if '-d' in args:
        print('n' + str(root / ('foreign-app' if mode == 'foreign-metro' else 'mobile')))
    elif any('8081' in arg for arg in args):
        print('999991' if reused else '', end='')
    elif any('8080' in arg for arg in args):
        print('999992' if mode == 'occupied-analysis' else '', end='')
elif name == 'ps':
    address = '10.0.0.99' if mode == 'reuse-wrong-url' else '10.0.0.8'
    print('EXPO_PUBLIC_ANALYSIS_BASE_URL=http://' + address + ':8080')
elif name == 'pgrep':
    result = subprocess.run([os.environ['QA_PGREP'], *args], capture_output=True, text=True)
    print(result.stdout, end='')
    sys.exit(result.returncode)
elif name == 'pnpm' and 'run:ios' in args:
    # Expo SDK57 rejects this combination; never let the fixture silently accept it.
    if '--no-bundler' in args and any(arg == '--port' or arg.startswith('--port=') for arg in args):
        print('Expo: --port and --no-bundler are mutually exclusive')
        sys.exit(1)
    if mode == 'native-fail':
        print('Native compiler failed')
        sys.exit(1)
    if mode == 'legacy':
        print('Build Succeeded\nInstalling ' + str(root / 'App.app') +
              '\nCoreDeviceError error 1000\ndevice process launch')
        sys.exit(1)
elif name == 'yugen-analysis-service' or (name == 'pnpm' and 'start' in args):
    service = 'analysis' if name == 'yugen-analysis-service' else 'metro'
    (state / service).touch()
    child = subprocess.Popen(['/bin/sleep', '300'])
    (state / (service + '-pids')).write_text(str(os.getpid()) + ' ' + str(child.pid))
    time.sleep(300)
elif name == 'sleep':
    time.sleep(.05)
""".replace('PYTHON', sys.executable)


def fixture(root, mode):
    for directory in ['mobile/scripts', 'bin', 'state', 'App.app', 'tmp',
                      'analysis-service/scripts', 'analysis-service/.data',
                      'analysis-service/build/install/yugen-analysis-service/bin']:
        (root / directory).mkdir(parents=True, exist_ok=True)
    script = root / 'mobile/scripts/start-dev.sh'
    shutil.copy(LAUNCHER, script)
    tools = [root / 'bin' / name for name in ['pnpm', 'java', 'curl', 'lsof', 'ps',
             'pgrep', 'xcrun', 'ideviceinstaller', 'idevicedebug', 'sleep']]
    tools += [root / 'analysis-service/gradlew', root / 'analysis-service/scripts/setup-data.sh',
              root / 'analysis-service/build/install/yugen-analysis-service/bin/yugen-analysis-service']
    for tool in tools:
        tool.write_text(FAKE_TOOL)
        tool.chmod(0o755)
    if mode != 'missing-data':
        data = root / 'analysis-service/.data'
        (data / 'sudachi-dictionary-20260116').mkdir()
        (data / 'sudachi-dictionary-20260116/system_core.dic').write_text('fixture')
        (data / 'JMdict_e_NG.gz').write_bytes(gzip.compress(b'fixture'))
        (data / 'kanjidic2.xml.gz').write_bytes(gzip.compress(b'fixture'))
    env = os.environ.copy()
    env.update(PATH=str(root / 'bin') + ':' + env['PATH'], QA_ROOT=str(root), QA_MODE=mode,
               QA_PGREP=REAL_PGREP, TMPDIR=str(root / 'tmp'), YUGEN_ANALYSIS_LAN_IP='10.0.0.8',
               YUGEN_IOS_DEVICE='fixture-device', OPENAI_API_KEY='fixture-placeholder')
    env.pop('YUGEN_ANALYSIS_DATA', None)
    return script, env


def run_case(root, mode):
    script, env = fixture(root, mode)
    device = mode in ['native-success', 'native-fail', 'legacy']
    output = root / 'output.log'
    with output.open('w') as log:
        process = subprocess.Popen(['/bin/sh', str(script), 'device' if device else '--server-only'],
                                   env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            text = output.read_text()
            ready = 'Ready: local furigana' in text
            if ready or process.poll() is not None:
                break
            time.sleep(.05)
        else:
            raise AssertionError(f'{mode}: launcher never completed startup')
        if ready:
            process.send_signal(signal.SIGTERM)
        code = process.wait(timeout=8)
        expected_ready = mode in ['auto', 'missing-data', 'reuse', 'native-success', 'legacy']
        assert ready == expected_ready, (mode, text)
        assert code == (143 if ready else 1), (mode, code, text)
        events = [json.loads(line) for line in (root / 'events.jsonl').read_text().splitlines()]
        for event in events:
            if event['tool'] in ['pnpm', 'curl', 'yugen-analysis-service']:
                assert event['ai'] == 'false' and not event['key_present'], (mode, 'AI environment leak')
        owned = [int(pid) for file in (root / 'state').glob('*-pids') for pid in file.read_text().split()]
        for pid in owned:
            status = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
            assert not status or status.startswith('Z'), (mode, 'owned process leak', pid, status)
        if mode == 'reuse':
            assert not owned
            assert not any(event['tool'] == 'pnpm' and 'start' in event['args'] for event in events)
        assert any(event['tool'] == 'setup-data.sh' for event in events) == (mode == 'missing-data')
        if mode == 'legacy':
            assert any(event['tool'] == 'ideviceinstaller' and 'upgrade' in event['args'] for event in events)
            debug = next(event for event in events if event['tool'] == 'idevicedebug')
            assert '--' in debug['args']
            assert debug['args'][-2:] == ['--initialUrl', 'http://10.0.0.8:8081']
        if device:
            native = [event for event in events if event['tool'] == 'pnpm' and 'run:ios' in event['args']]
            assert len(native) == 1
            assert '--no-bundler' in native[0]['args'] and '--port' not in native[0]['args']
        print(f'PASS {mode}: owned process subtree stopped ({len(owned)} processes)')
    finally:
        # Clean up a broken fixture too, without touching any real service.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def check_dictionary_setup(root):
    """Adding kanji data downloads only that file; existing snapshots stay intact."""
    root.mkdir()
    data = root / 'data'
    (data / 'sudachi-dictionary-20260116').mkdir(parents=True)
    (data / 'sudachi-dictionary-20260116/system_core.dic').write_text('existing')
    jmdict = gzip.compress(b'<JMdict/>')
    (data / 'JMdict_e_NG.gz').write_bytes(jmdict)
    (data / 'manifest.txt').write_text('JMdict retrieved UTC: 2026-10-01\n')
    tools = root / 'bin'
    tools.mkdir()
    curl = tools / 'curl'
    curl.write_text('#!' + sys.executable + '\n' + """
import gzip, os, sys
from pathlib import Path
assert sys.argv[-3] == 'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz', sys.argv
Path(sys.argv[-1]).write_bytes(gzip.compress(b'<kanjidic2/>'))
with open(os.environ['QA_DOWNLOADS'], 'a') as log: log.write('kanjidic2\\n')
""")
    curl.chmod(0o755)
    env = os.environ.copy()
    env.update(PATH=str(tools) + ':' + env['PATH'], YUGEN_ANALYSIS_DATA=str(data),
               QA_DOWNLOADS=str(root / 'downloads'))
    for variable in ['SUDACHI_SOURCE_FILE', 'JMDICT_SOURCE_FILE', 'KANJIDIC_SOURCE_FILE']:
        env.pop(variable, None)
    setup = LAUNCHER.parents[2] / 'analysis-service/scripts/setup-data.sh'
    for _ in range(2):
        result = subprocess.run(['bash', str(setup), '--missing'], env=env, capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
    assert (root / 'downloads').read_text().splitlines() == ['kanjidic2']
    assert (data / 'JMdict_e_NG.gz').read_bytes() == jmdict
    assert 'JMdict retrieved UTC: 2026-10-01' in (data / 'manifest.txt').read_text()
    assert 'KANJIDIC2 archive SHA-256:' in (data / 'manifest.txt').read_text()
    print('PASS dictionary setup: missing kanji downloaded once; existing data retained')


def main():
    assert REAL_PGREP, 'This launcher check requires the platform pgrep utility.'
    with TemporaryDirectory(prefix='yugen-launcher-check-') as directory:
        check_dictionary_setup(Path(directory) / 'dictionary-setup')
        for mode in ['auto', 'missing-data', 'reuse', 'reuse-wrong-url', 'foreign-analysis',
                     'occupied-analysis', 'foreign-metro', 'native-success', 'native-fail', 'legacy']:
            run_case(Path(directory) / mode, mode)
    print('PASS 10 launcher scenarios; no real network, install, device, or provider calls')


if __name__ == '__main__':
    main()
