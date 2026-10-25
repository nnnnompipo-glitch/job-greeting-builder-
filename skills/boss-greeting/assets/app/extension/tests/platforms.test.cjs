const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const registry=require('../platforms.cjs');
const extension=path.join(__dirname,'..');
function element(value='',queries={},options={}) {
  return {innerText:value,isConnected:true,classList:{contains:name=>options.clamped && name==='describtion-card__detail-content--guest-clamp'},
    querySelectorAll:selector=>queries[selector]||[],querySelector:selector=>(queries[selector]||[])[0]||null,
    closest:selector=>(options.hidden&&selector.includes('[hidden]'))||(options.list&&selector.includes('.job-list'))?{}:null,
    getClientRects:()=>options.hidden?[]:[{}]};
}
function extractor() {
  const scope={URL,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};vm.createContext(scope);
  for(const file of ['platforms.cjs','extract.js'])vm.runInContext(fs.readFileSync(path.join(extension,file),'utf8'),scope);
  return scope.RecruitmentJobExtractor.extract;
}
const description='负责产品工业设计、用户调研、外观方案和三维建模，协同结构工程师进行工厂打样与量产跟进。';
test('strict shared routes recognize three platforms and canonicalize legacy Zhilian links',()=>{
  for(const [url,id] of [
    ['https://www.zhipin.com/job_detail/abc.html?securityId=test','boss'],
    ['https://www.zhipin.com/web/geek/job-recommend','boss'],
    ['https://www.liepin.com/job/1986231537.shtml?source=example','liepin'],
    ['https://www.liepin.com/a/12345678.shtml','liepin'],
    ['https://www.zhaopin.com/jobdetail/CC585435125J00668996301.htm','zhilian']]) {
    assert.equal(registry.identifyJobURL(url).id,id);assert.equal(registry.identifyJobURL(url).canonicalUrl.includes('?'),false);
  }
  assert.equal(registry.identifyJobURL('https://jobs.zhaopin.com/CC585435125J00668996301.htm').canonicalUrl,'https://www.zhaopin.com/jobdetail/CC585435125J00668996301.htm');
  for(const url of ['https://www.liepin.com/zhaopin/','https://www.liepin.com/job/12345.shtml/chat','https://h.liepin.com/job/12345.shtml',
    'https://www.zhaopin.com/chat','https://www.zhaopin.com/jobdetail/short','https://jobs.zhaopin.com.evil.test/CC123J456.htm',
    'http://www.liepin.com/job/12345.shtml','https://user@www.liepin.com/job/12345.shtml','https://www.zhaopin.com:123/jobdetail/CC123J456.htm']) assert.equal(registry.identifyJobURL(url),null);
});
test('Liepin standalone combines only unique visible explicit header and introduction areas',()=>{
  const header=element('',{'.name-box .name':[element('工业设计师')],'.salary':[element('10-15k')],'.job-properties':[element('杭州 本科')]});
  const detail=element('',{'[data-selector="job-intro-content"]':[element(description)]});
  const doc=element('无关职位和聊天', {'.job-apply-container':[header],'.job-apply-container-desc .job-intro-container':[detail],'.company-info-container .company-card .content .name':[element('示例企业')]});
  const job=extractor()(doc,'https://www.liepin.com/job/1986231537.shtml');
  assert.equal(job.title,'工业设计师');assert.equal(job.company,'示例企业');assert.equal(job.platform,'liepin');assert.equal(job.description,description);
  assert.equal(extractor()(element('',{'.job-apply-container':[header,header],'.job-apply-container-desc .job-intro-container':[detail]}),'https://www.liepin.com/job/1986231537.shtml'),null);
  assert.equal(extractor()(element('',{'.job-apply-container':[header],'.job-apply-container-desc .job-intro-container':[element('',{'[data-selector="job-intro-content"]':[element(description)]},{hidden:true})]}),'https://www.liepin.com/job/1986231537.shtml'),null);
});
test('Zhilian extracts current description without neighboring recommendations and declines guest-clamped text',()=>{
  const fields={'.summary-planes__title':[element('工业设计工程师')],'.describtion-card__detail-content':[element(description)],'.company-info__name':[element('示例智联企业')]};
  const doc=element('推荐岗位不能采集',{'.main-jobs':[element('',fields)]});
  const job=extractor()(doc,'https://jobs.zhaopin.com/CC585435125J00668996301.htm');
  assert.equal(job.platform,'zhilian');assert.equal(job.description,description);assert.equal(job.company,'示例智联企业');
  const guest=element('',{'.main-jobs':[element('',{...fields,'.describtion-card__detail-content':[element(description,{}, {clamped:true})]})]});
  assert.equal(extractor()(guest,'https://www.zhaopin.com/jobdetail/CC585435125J00668996301.htm'),null);
});
