import json,subprocess,re,sys,glob
pdf=glob.glob('out/*.pdf')[0]
heads=json.load(open('out/heads.json'))
n=int(re.search(r'Pages:\s+(\d+)',subprocess.run(['pdfinfo',pdf],capture_output=True,text=True).stdout).group(1))
pages=[re.sub(r'\s+',' ',subprocess.run(['pdftotext','-f',str(i),'-l',str(i),pdf,'-'],capture_output=True,text=True).stdout) for i in range(1,n+1)]
res={};start=2
for lvl,t in heads:
    key=re.sub(r'\s+',' ',t)[:40]
    for i in range(start,n):
        if key in pages[i]:
            res[t]=i+1;start=i;break
    else: print('MISS',t)
json.dump(res,open('out/toc-pages.json','w'),ensure_ascii=False)
print(len(res),'of',len(heads))
