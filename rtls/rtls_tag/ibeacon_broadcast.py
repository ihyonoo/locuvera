# ibeacon_broadcast.py

import subprocess


def run_command(cmd):
    subprocess.run(cmd, shell=True, check=True)


def start():
    # 데모용 태그 브로드캐스트라서 시스템 블루투스 서비스를 멈추고 HCI를 직접 제어한다.
    run_command("sudo systemctl stop bluetooth")
    run_command("sudo hciconfig hci0 up")

    # broadcast 파라미터 (200ms)
    run_command("sudo hcitool -i hci0 cmd 0x08 0x0006 40 01 40 01 03 00 00 00 00 00 00 00 07 00")

    # iBeacon broadcast 데이터
    # UUID: fda50693-a4e2-4fb1-afcf-c6eb07647825
    # Major: 1
    # Minor: 1
    run_command(
        "sudo hcitool -i hci0 cmd 0x08 0x0008 1E "
        "02 01 06 "
        "1A FF 4C 00 02 15 "
        "FD A5 06 93 A4 E2 4F B1 AF CF C6 EB 07 64 78 25 "
        "00 01 00 01 C5 "
        "00 00 00 00 00 00 00 00 00 00 00"
    )

    # broadcast ON
    run_command("sudo hcitool -i hci0 cmd 0x08 0x000A 01")


if __name__ == "__main__":
    start()
