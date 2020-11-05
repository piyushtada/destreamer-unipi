#!/usr/bin/env python3

import os
import sys

string = ""
filename = os.path.basename(__file__)
for arg in sys.argv:
	if (arg != "python" and arg!="python3" and arg!= "./"+filename and arg!= filename):
		string+= (arg+" ")

print('''\n\nRunning forever-plugin for destreamer! 
I will keep working after crash!
You are running with this arguments: {}

Remember to close with ctrl+z, or i will run forever!\n\n'''.format(string))

while True:
	os.system("./destreamer.sh "+string)

# us use this command to run the script
# python3 ./forever.py -f list.txt -O ./desidered/folder --format mp4 --skip