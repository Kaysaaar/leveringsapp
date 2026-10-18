'use strict';
const PREVIEW_DIRECTORY_KEY='wallmann_preview_driver_directory';
function previewDirectory() {
  try{const saved=JSON.parse(localStorage.getItem(PREVIEW_DIRECTORY_KEY)||'null');if(saved && Array.isArray(saved.drivers))return saved;}catch(_){}
  return {revision:1,drivers:['Brian','Chauffør','Erik','Henrik','Jeppe','Niels','Otto','Thomas M','Thomas O'].map((name,i)=>({id:'driver_'+(i+1),name,active:true}))};
}
function previewHomeData(){return {drivers:previewDirectory().drivers.filter(d=>d.active).map(d=>({id:d.id,name:d.name})),summary:{month:homeMonth(),total:284,yearTotal:3176,asOf:new Date().toISOString()}};}
async function previewAdminCall(action,args){
  const current=previewDirectory();
  if(action==='listDriversAdmin')return current;
  if(args.revision!==current.revision)throw new Error('Listen er ændret i en anden fane. Genåbn administrationen.');
  if(action==='addDriverAdmin') {
    const name=String(args.name||'').trim().replace(/\s+/g,' ');
    if(!name || name.length>120 || /^[=+@-]/.test(name))throw new Error('Indtast et gyldigt chaufførnavn.');
    if(current.drivers.some(d=>d.name.toLocaleLowerCase('da-DK')===name.toLocaleLowerCase('da-DK')))throw new Error('Navnet findes allerede. Genaktivér chaufføren, hvis nødvendigt.');
    current.drivers.push({id:'driver_'+crypto.randomUUID(),name,active:true});
  }else if(action==='setDriverActiveAdmin'){
    const driver=current.drivers.find(d=>d.id===args.id);if(!driver)throw new Error('Chaufføren findes ikke længere.');driver.active=args.active===true;
  }else throw new Error('Ukendt handling.');
  current.revision++;localStorage.setItem(PREVIEW_DIRECTORY_KEY,JSON.stringify(current));return current;
}
