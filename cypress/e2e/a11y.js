import { reportA11y } from '../support/accessibility'

describe('a11y', () => {
    it('home should have no accessibility violations', () => {
        cy.get('[data-attr="menu-item-projecthomepage"]').click()
        cy.injectAxe()
        reportA11y({ includedImpacts: ['critical'] }, 'home-page-critical', false)
        reportA11y({ includedImpacts: ['serious'] }, 'home-page-serious', true)
    })

    const sidebarItems = [
        'dashboards',
        'savedinsights',
        'sessionsrecordings',
        'featureflags',
        'experiments',
        'events',
        'datamanagement',
        'persons',
        'cohorts',
        'annotations',
        'plugins',
        'toolbarlaunch',
        'projectsettings',
    ]

    sidebarItems.forEach((sideBarItem) => {
        it(`${sideBarItem} should have no accessibility violations`, () => {
            cy.clickNavMenu(sideBarItem)
            cy.injectAxe()
            reportA11y({ includedImpacts: ['serious', 'critical'] }, sideBarItem)
        })
    })
})
