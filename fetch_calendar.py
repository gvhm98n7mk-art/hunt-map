"""Pull the iCloud public calendar (webcal) and write data/calendar.json: one row per event-day for the next 180 days."""
import os, sys, json, datetime as dt, urllib.request
from icalendar import Calendar
import recurring_ical_events
url=os.environ.get('CAL_URL','').replace('webcal://','https://')
if not url: print('CAL_URL secret not set'); sys.exit(0)
raw=urllib.request.urlopen(url, timeout=60).read()
cal=Calendar.from_ical(raw)
start=dt.date.today()-dt.timedelta(days=7); end=start+dt.timedelta(days=187)
rows=[]
for ev in recurring_ical_events.of(cal).between(start,end):
    s=ev.get('DTSTART').dt; e=ev.get('DTEND').dt if ev.get('DTEND') else s
    allday=not isinstance(s,dt.datetime)
    sd=s if allday else s.astimezone().date(); ed=(e if allday else e.astimezone().date())
    if not allday and isinstance(e,dt.datetime) and e.astimezone().time()==dt.time(0,0): ed=ed-dt.timedelta(days=1)
    if allday and e!=s: ed=e-dt.timedelta(days=1)
    d=sd
    while d<=max(sd,ed):
        rows.append({'date':d.isoformat(),'summary':str(ev.get('SUMMARY','')),'allDay':allday}); d+=dt.timedelta(days=1)
rows.sort(key=lambda r:r['date'])
json.dump(rows,open('calendar.json','w'),indent=0)
print(len(rows),'event-days written')
