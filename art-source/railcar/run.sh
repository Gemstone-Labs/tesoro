#!/bin/bash
cd ~/Work/gemstone-labs/tesoro/art-source/railcar
run() { s=$1; code=$2
 mkdir -p $s
 codex exec --sandbox workspace-write --skip-git-repo-check -C "$PWD" "You are Astra. Read BRIEF.md (the common brief) and SCREEN-$s.md in this folder. Produce ONLY that screen: the 3 takes as exact 390x844 PNGs at $s/${code}1-390.png, ${code}2-390.png, ${code}3-390.png. Attach reference images from attach/ (max five per generation, as BRIEF.md lists). Generate each take separately, resize/crop to exactly 390x844 if needed (verify with magick identify), log every prompt in PROMPTS-log-$s.md, run the self-check from BRIEF.md, then stop." < /dev/null > astra-$s.log 2>&1
}
(run boarding bo; run result re; run history hi) &
(run ride ri; run spectator sp) &
wait
echo ALLDONE > done.flag
